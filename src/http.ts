import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerOk } from "./auth.js";
import type { Config } from "./config.js";
import type { MailAccount } from "./mail-account.js";
import { log, logError } from "./logging.js";
import { buildMcpServer } from "./mcp.js";

const MAX_BODY_BYTES = 1_000_000;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

class PayloadTooLargeError extends Error {}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new PayloadTooLargeError("payload too large"));
      return;
    }
    req.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        chunks.length = 0;
        reject(new PayloadTooLargeError("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!overflow) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function handle(config: Config, account: MailAccount, version: string, req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  let pathname = "(unparsed)";
  res.on("finish", () => {
    log("info", "http", { method: req.method ?? "?", path: pathname, status: res.statusCode, ms: Date.now() - started });
  });

  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    sendJson(res, 400, { error: "bad_request" });
    return;
  }
  if (pathname !== "/mcp") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!bearerOk(config.token, req.headers.authorization)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="imap-mcp"');
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  let body: object;
  try {
    const parsed: unknown = JSON.parse(await readBody(req, MAX_BODY_BYTES));
    if (typeof parsed !== "object" || parsed === null) {
      sendJson(res, 400, { error: "invalid_request" });
      return;
    }
    body = parsed;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      if (!res.destroyed) sendJson(res, 413, { error: "payload_too_large" });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }
    logError("warn", "client_abort", error);
    if (!res.writableEnded && !res.destroyed) sendJson(res, 400, { error: "client_abort" });
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = buildMcpServer(account, version);
    res.on("close", () => {
      void Promise.allSettled([mcp.close(), transport.close()]);
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    logError("error", "mcp_request_failed", error);
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    else res.end();
  }
}

export function createHttpServer(config: Config, account: MailAccount, version: string): Server {
  return createServer((req, res) => {
    void handle(config, account, version, req, res);
  });
}
