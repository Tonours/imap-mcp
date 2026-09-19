import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LIMIT_DEFAULT, LIMIT_MAX } from "./imap.js";
import { isCalendarDate, MailAccount, MailAccountError, MailNotFoundError } from "./mail-account.js";
import { log } from "./logging.js";
import { SUBJECT_MAX, TEXT_MAX } from "./rfc822.js";

const SERVER_NAME = "imap-mcp";
const calendarDate = z.string().refine(isCalendarDate, "YYYY-MM-DD must be a real calendar date");
const messageInput = {
  to: z.array(z.string().email()).min(1).max(20),
  cc: z.array(z.string().email()).max(20).optional(),
  subject: z.string().min(1).max(SUBJECT_MAX),
  text: z.string().min(1).max(TEXT_MAX),
};

function toolError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function withToolLog<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    log("info", "tool", { name, ms: Date.now() - started });
  }
}

async function withToolErrors<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MailAccountError || error instanceof MailNotFoundError) {
      return toolError(`${error instanceof MailAccountError ? error.code : "not_found"}: ${error.message}`);
    }
    throw error;
  }
}

export function buildMcpServer(account: MailAccount, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version });

  server.registerTool(
    "mail_health",
    {
      description: "Ping the MCP server and its IMAP connection. Returns version, uptime and IMAP status.",
      inputSchema: {},
    },
    async () =>
      withToolLog("mail_health", async () => {
        const imap = await account.health();
        return jsonResult({ status: "ok", version, uptimeSec: Math.floor(process.uptime()), imap });
      }),
  );

  server.registerTool(
    "mail_list_folders",
    { description: "List all IMAP folders of the mailbox.", inputSchema: {} },
    async () => withToolLog("mail_list_folders", async () => jsonResult({ folders: await account.listFolders() })),
  );

  server.registerTool(
    "mail_search",
    {
      description:
        "Search messages in a folder with simple IMAP criteria (from, to, subject, since, before, unseen). Returns the highest matching UIDs with metadata, highest UID first.",
      inputSchema: {
        folder: z.string().min(1).default("INBOX"),
        from: z.string().min(1).optional(),
        to: z.string().min(1).optional(),
        subject: z.string().min(1).optional(),
        since: calendarDate.optional(),
        before: calendarDate.optional(),
        unseen: z.boolean().optional(),
        limit: z.number().int().min(1).max(LIMIT_MAX).default(LIMIT_DEFAULT),
      },
    },
    async ({ folder, from, to, subject, since, before, unseen, limit }) =>
      withToolLog("mail_search", async () => {
        const messages = await account.search(folder, { from, to, subject, since, before, unseen, limit });
        return jsonResult({ folder, count: messages.length, messages });
      }),
  );

  server.registerTool(
    "mail_get",
    {
      description:
        "Fetch one message by folder + uid. Returns headers, capped text, a capped HTML excerpt and attachment metadata. Attachment contents are never returned.",
      inputSchema: { uid: z.number().int().positive(), folder: z.string().min(1).default("INBOX") },
    },
    async ({ uid, folder }) =>
      withToolLog("mail_get", async () =>
        withToolErrors(async () => jsonResult({ ...(await account.get(folder, uid)) })),
      ),
  );

  server.registerTool(
    "mail_send",
    {
      description:
        "Send a plain-text email as the configured sender. Refuses unless ALLOW_SEND=true. No BCC, HTML or attachments. Rate-limited.",
      inputSchema: messageInput,
    },
    async ({ to, cc, subject, text }) =>
      withToolLog("mail_send", async () =>
        withToolErrors(async () =>
          jsonResult({ sent: true, ...(await account.send({ to, cc: cc ?? [], subject, text })) }),
        ),
      ),
  );

  server.registerTool(
    "mail_create_draft",
    {
      description:
        "Create a plain-text draft as the configured sender. Refuses unless ALLOW_SEND=true. Rate-limited with mail_send.",
      inputSchema: messageInput,
    },
    async ({ to, cc, subject, text }) =>
      withToolLog("mail_create_draft", async () =>
        withToolErrors(async () => {
          const draft = await account.createDraft({ to, cc: cc ?? [], subject, text });
          return jsonResult({
            drafted: true,
            folder: draft.folder,
            uidValidity: draft.uidValidity,
            uid: draft.uid,
            date: new Date().toISOString(),
            to,
            subject,
          });
        }),
      ),
  );

  server.registerTool(
    "mail_trash",
    {
      description:
        "Move one message to the unique IMAP trash folder. Refuses unless ALLOW_TRASH=true. Never permanently deletes or expunges mail. Rate-limited independently.",
      inputSchema: { uid: z.number().int().positive(), folder: z.string().min(1).default("INBOX") },
    },
    async ({ uid, folder }) =>
      withToolLog("mail_trash", async () =>
        withToolErrors(async () => jsonResult({ trashed: true, ...(await account.trash(folder, uid)) })),
      ),
  );

  return server;
}
