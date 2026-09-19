import { z } from "zod";
import type { MutationPolicy } from "./mail-account.js";

export type SmtpSecurity = "implicit" | "starttls";

export interface Config {
  token: string;
  imap: {
    host: string;
    port: number;
    tls: boolean;
    user: string;
    pass: string;
    timeoutMs: number;
  };
  smtp: {
    host: string;
    port: number;
    security: SmtpSecurity;
    user: string;
    pass: string;
    from: string;
  } | null;
  sendPolicy: MutationPolicy;
  trashPolicy: MutationPolicy;
  http: {
    host: string;
    port: number;
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const EMAIL = z.string().email();

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`missing required env var: ${key}`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.length === 0) throw new Error(`missing required env var: ${key}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole integer between ${minimum} and ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} must be true or false`);
}

function email(value: string, key: string): string {
  if (!EMAIL.safeParse(value).success) throw new Error(`${key} must be a valid email address`);
  return value;
}

function loadSmtp(env: NodeJS.ProcessEnv, imapUser: string, imapPass: string, enabled: boolean): Config["smtp"] {
  if (!enabled) return null;
  const host = required(env, "SMTP_HOST");
  const security = required(env, "SMTP_SECURITY");
  if (security !== "implicit" && security !== "starttls") {
    throw new Error("SMTP_SECURITY must be implicit or starttls");
  }

  const rawUser = env["SMTP_USER"]?.trim() ?? "";
  const rawPass = env["SMTP_PASS"] ?? "";
  if ((rawUser === "") !== (rawPass === "")) {
    throw new Error("SMTP_USER and SMTP_PASS must both be set or both be absent");
  }
  const user = rawUser || imapUser;
  const pass = rawPass || imapPass;
  const from = email(env["MAIL_FROM"]?.trim() || user, "MAIL_FROM");
  const defaultPort = security === "implicit" ? 465 : 587;

  return {
    host,
    port: integer(env, "SMTP_PORT", defaultPort, 1, 65_535),
    security,
    user,
    pass,
    from,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = secret(env, "MCP_AUTH_TOKEN");
  if (token !== token.trim()) {
    throw new Error("MCP_AUTH_TOKEN must not have leading or trailing whitespace");
  }
  if (token.length < 16) {
    throw new Error("MCP_AUTH_TOKEN too weak: generate one with `openssl rand -base64 32`");
  }

  const imapUser = required(env, "IMAP_USER");
  const imapPass = secret(env, "IMAP_PASS");
  const sendEnabled = boolean(env, "ALLOW_SEND", false);
  const trashEnabled = boolean(env, "ALLOW_TRASH", false);
  const rawLevel = env["LOG_LEVEL"] ?? "info";
  const parsedLevel = z.enum(LOG_LEVELS).safeParse(rawLevel);
  if (!parsedLevel.success) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(", ")}`);
  }

  return {
    token,
    imap: {
      host: required(env, "IMAP_HOST"),
      port: integer(env, "IMAP_PORT", 993, 1, 65_535),
      tls: boolean(env, "IMAP_TLS", true),
      user: imapUser,
      pass: imapPass,
      timeoutMs: integer(env, "IMAP_TIMEOUT_MS", 15_000, 1_000, 300_000),
    },
    smtp: loadSmtp(env, imapUser, imapPass, sendEnabled),
    sendPolicy: {
      enabled: sendEnabled,
      perHour: integer(env, "SEND_RATE_PER_HOUR", 5, 0, 10_000),
    },
    trashPolicy: {
      enabled: trashEnabled,
      perHour: integer(env, "TRASH_RATE_PER_HOUR", 20, 0, 10_000),
    },
    http: {
      host: env["HOST"]?.trim() || "127.0.0.1",
      port: integer(env, "PORT", 3000, 1, 65_535),
    },
    logLevel: parsedLevel.data,
  };
}
