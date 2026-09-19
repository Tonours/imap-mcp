import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { ImapMailbox } from "./imap.js";
import { MailAccount } from "./mail-account.js";
import { log, logError, setLogLevel } from "./logging.js";
import { SmtpSender } from "./smtp.js";

export const SERVER_VERSION = "0.1.0";

interface ClosableAccount {
  close(): Promise<void>;
}

interface ClosableServer {
  close(callback: (error?: Error) => void): void;
}

function closeServer(server: ClosableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function closeRuntime(server: ClosableServer, account: ClosableAccount, timeoutMs: number = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const cleanup = closeServer(server).then(() => account.close());
    await Promise.race([cleanup, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logError("error", "config_invalid", error);
    process.exitCode = 1;
    return;
  }

  setLogLevel(config.logLevel);
  process.on("unhandledRejection", (reason) => logError("error", "unhandled_rejection", reason));

  const mailbox = new ImapMailbox(config.imap);
  const sender = config.smtp ? new SmtpSender(config.smtp) : null;
  const account = new MailAccount({
    mailbox,
    sender,
    from: config.smtp?.from ?? null,
    sendPolicy: config.sendPolicy,
    trashPolicy: config.trashPolicy,
  });
  const server = createHttpServer(config, account, SERVER_VERSION);

  server.listen(config.http.port, config.http.host, () => {
    log("info", "listening", { host: config.http.host, port: config.http.port, version: SERVER_VERSION });
  });

  let closing: Promise<void> | null = null;
  const shutdown = (signal: string) => {
    if (closing) return;
    log("info", "shutdown", { signal });
    closing = closeRuntime(server, account).then(
      () => process.exit(0),
      (error) => {
        logError("error", "shutdown_failed", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMain()) main();
