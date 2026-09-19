import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { bearerOk } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { ImapMailbox } from "../src/imap.js";
import {
  MailAccount,
  MailNotFoundError,
  type FolderInfo,
  type MailContent,
  type MailInput,
  type MailboxAdapter,
  type MailSummary,
  type SearchCriteria,
  type SendResult,
  type SenderAdapter,
} from "../src/mail-account.js";
import { encodeSubject } from "../src/rfc822.js";
import { SmtpSender } from "../src/smtp.js";

const TOKEN = "smoke-test-token-0123456789";

function testConfig(): Config {
  return {
    token: TOKEN,
    imap: { host: "imap.example.com", port: 993, tls: true, user: "u@example.com", pass: "p", timeoutMs: 1000 },
    smtp: null,
    sendPolicy: { enabled: false, perHour: 5 },
    trashPolicy: { enabled: false, perHour: 20 },
    http: { host: "127.0.0.1", port: 3000 },
    logLevel: "error",
  };
}

function summary(uid: number, seen: boolean): MailSummary {
  return {
    uid,
    folder: "INBOX",
    subject: `Subject ${uid}`,
    from: "Sender <sender@example.com>",
    to: "recipient@example.com",
    date: "2026-03-06T10:00:00.000Z",
    seen,
  };
}

function content(uid: number): MailContent {
  return {
    ...summary(uid, false),
    textPlain: "Message body.",
    textTruncated: false,
    htmlExcerpt: "<p>Message body.</p>",
    htmlOnly: false,
    attachments: [{ filename: "invoice.pdf", size: 1024, contentType: "application/pdf" }],
  };
}

class FakeMailbox implements MailboxAdapter {
  folders: FolderInfo[] = [
    { path: "INBOX", specialUse: "\\Inbox" },
    { path: "Trash", specialUse: "\\Trash" },
  ];
  lastSearch: { folder: string; criteria: SearchCriteria } | null = null;
  lastGet: { folder: string; uid: number } | null = null;
  lastDraft: string | null = null;
  lastMove: { source: string; uid: number; destination: string } | null = null;

  async health() { return { connected: true, host: "imap.example.com" }; }
  async listFolders() { return this.folders; }
  async search(folder: string, criteria: SearchCriteria): Promise<MailSummary[]> {
    this.lastSearch = { folder, criteria };
    return [summary(42, false), summary(41, true)];
  }
  async get(folder: string, uid: number): Promise<MailContent> {
    this.lastGet = { folder, uid };
    if (uid !== 42) throw new MailNotFoundError(folder, uid);
    return content(uid);
  }
  async appendDraft(rfc822: string) {
    this.lastDraft = rfc822;
    return { folder: "Drafts", uidValidity: 12345, uid: 777 };
  }
  async move(source: string, uid: number, destination: string) {
    this.lastMove = { source, uid, destination };
    return { destinationUid: 900 };
  }
  async close() {}
}

class FakeSender implements SenderAdapter {
  captured: MailInput[] = [];
  async send(input: MailInput): Promise<SendResult> {
    this.captured.push(input);
    return { messageId: "<fake@example.com>", accepted: input.to, rejected: [], envelope: { from: input.from, to: input.to } };
  }
}

function account(mailbox: FakeMailbox, options: { send?: boolean; trash?: boolean; sender?: SenderAdapter } = {}) {
  return new MailAccount({
    mailbox,
    sender: options.sender ?? null,
    from: options.send ? "sender@example.com" : null,
    sendPolicy: { enabled: options.send ?? false, perHour: 5 },
    trashPolicy: { enabled: options.trash ?? false, perHour: 20 },
  });
}

let rpcId = 0;
function rpc(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
}

interface RpcResponse { result?: Record<string, unknown>; error?: unknown }

async function closeTestServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

async function listenTestServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function parseRpc(res: Response): Promise<RpcResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) return (await res.json()) as RpcResponse;
  assert.ok(res.body);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        const parsed = JSON.parse(payload) as RpcResponse;
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  throw new Error("SSE stream ended without a result payload");
}

describe("bearer auth", () => {
  it("accepts only the configured bearer", () => {
    assert.equal(bearerOk(TOKEN, undefined), false);
    assert.equal(bearerOk(TOKEN, "Basic abc"), false);
    assert.equal(bearerOk(TOKEN, `Bearer ${TOKEN}`), true);
    assert.equal(bearerOk(TOKEN, `bearer ${TOKEN}`), true);
    assert.equal(bearerOk(TOKEN, "Bearer wrong-token-same-ish-length-123"), false);
  });
});

describe("HTTP and MCP", () => {
  let server: Server;
  let base: string;
  const mailbox = new FakeMailbox();

  before(async () => {
    server = createHttpServer(testConfig(), account(mailbox), "test");
    base = await listenTestServer(server);
  });

  after(async () => closeTestServer(server));

  function post(body: string, headers: Record<string, string> = {}) {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      },
      body,
    });
  }

  it("enforces route, method, auth, JSON and body size", async () => {
    assert.equal((await fetch(`${base}/other`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    assert.equal((await post(rpc("initialize", {}), { authorization: "" })).status, 401);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post("null")).status, 400);
    assert.equal((await post(rpc("initialize", { pad: "x".repeat(1_100_000) }))).status, 413);
  });

  it("initializes and exposes the seven tools", async () => {
    const initialized = await parseRpc(await post(rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    })));
    assert.equal((initialized.result as { serverInfo?: { name?: string } })?.serverInfo?.name, "imap-mcp");
    const listed = await parseRpc(await post(rpc("tools/list", {})));
    const tools = (listed.result as { tools?: { name: string }[] })?.tools ?? [];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "mail_create_draft", "mail_get", "mail_health", "mail_list_folders", "mail_search", "mail_send", "mail_trash",
    ]);
  });

  it("passes JSON-RPC batches to the MCP transport", async () => {
    const response = await post(JSON.stringify([
      { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} },
    ]));
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  });

  it("delegates read operations and validates real calendar dates", async () => {
    const searched = await parseRpc(await post(rpc("tools/call", { name: "mail_search", arguments: { from: "acme", unseen: true } })));
    assert.equal((searched.result as { structuredContent?: { count?: number } }).structuredContent?.count, 2);
    assert.equal(mailbox.lastSearch?.criteria.limit, 20);
    const fetched = await parseRpc(await post(rpc("tools/call", { name: "mail_get", arguments: { uid: 42 } })));
    assert.equal((fetched.result as { structuredContent?: { subject?: string } }).structuredContent?.subject, "Subject 42");
    const invalid = await parseRpc(await post(rpc("tools/call", { name: "mail_search", arguments: { since: "2026-02-31" } })));
    assert.ok(invalid.error !== undefined || (invalid.result as { isError?: boolean } | undefined)?.isError === true);
  });

  it("returns tool errors for disabled mutations and missing mail", async () => {
    for (const [name, args, message] of [
      ["mail_send", { to: ["x@example.com"], subject: "s", text: "hello" }, /send capability is disabled/],
      ["mail_create_draft", { to: ["x@example.com"], subject: "s", text: "hello" }, /send capability is disabled/],
      ["mail_trash", { uid: 42 }, /trash capability is disabled/],
      ["mail_get", { uid: 999 }, /not_found/],
    ] as const) {
      const response = await parseRpc(await post(rpc("tools/call", { name, arguments: args })));
      const result = response.result as { isError?: boolean; content?: { text: string }[] };
      assert.equal(result.isError, true);
      assert.match(result.content?.[0]?.text ?? "", message);
    }
  });
});

describe("enabled mutation tools", () => {
  let server: Server;
  let base: string;
  const mailbox = new FakeMailbox();
  const sender = new FakeSender();

  before(async () => {
    server = createHttpServer(testConfig(), account(mailbox, { send: true, trash: true, sender }), "test");
    base = await listenTestServer(server);
  });
  after(async () => closeTestServer(server));

  async function call(name: string, args: object) {
    return parseRpc(await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}` },
      body: rpc("tools/call", { name, arguments: args }),
    }));
  }

  it("sends, creates drafts and moves messages to trash", async () => {
    const sent = await call("mail_send", { to: ["recipient@example.com"], subject: "Subject", text: "Body" });
    assert.equal((sent.result as { structuredContent?: { sent?: boolean } }).structuredContent?.sent, true);
    assert.equal(sender.captured[0]?.from, "sender@example.com");
    const drafted = await call("mail_create_draft", { to: ["recipient@example.com"], subject: "Réponse", text: "Body" });
    assert.equal((drafted.result as { structuredContent?: { drafted?: boolean } }).structuredContent?.drafted, true);
    assert.match(mailbox.lastDraft ?? "", /=\?UTF-8\?B\?/);
    const trashed = await call("mail_trash", { folder: "INBOX", uid: 42 });
    assert.equal((trashed.result as { structuredContent?: { trashed?: boolean } }).structuredContent?.trashed, true);
    assert.deepEqual(mailbox.lastMove, { source: "INBOX", uid: 42, destination: "Trash" });
  });
});

describe("mail formatting and SMTP adapter", () => {
  it("keeps encoded subject words under 75 octets", () => {
    const words = encodeSubject("éàç".repeat(200)).split("\r\n ");
    assert.ok(words.length > 1);
    for (const word of words) assert.ok(word.length <= 75);
    assert.equal(encodeSubject("Simple subject"), "Simple subject");
  });

  it("maps the transporter response and omits empty cc", async () => {
    const captured: unknown[] = [];
    const transporter = {
      sendMail: async (mail: unknown) => {
        captured.push(mail);
        return { messageId: "<stub@example.com>", accepted: [{ address: "a@example.com" }], rejected: [], envelope: { from: "u@example.com", to: ["a@example.com"] } };
      },
    };
    const sender = new SmtpSender(
      { host: "smtp.example.com", port: 465, security: "implicit", user: "u@example.com", pass: "p" },
      transporter,
    );
    const result = await sender.send({ from: "u@example.com", to: ["a@example.com"], cc: [], subject: "S", text: "T" });
    assert.equal(result.messageId, "<stub@example.com>");
    assert.equal((captured[0] as { cc?: unknown }).cc, undefined);
  });
});

if (process.env.MCP_IT === "1") {
  describe("integration against a configured IMAP account", () => {
    it("connects and searches the inbox", async () => {
      const config = loadConfig();
      const mailbox = new ImapMailbox(config.imap);
      assert.equal((await mailbox.health()).connected, true);
      assert.ok((await mailbox.search("INBOX", { limit: 1 })).length <= 1);
      await mailbox.close();
    });
  });
}
