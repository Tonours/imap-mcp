export type LogLevel = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null>;

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function scrub(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "Bearer ***");
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  if (WEIGHT[level] < WEIGHT[currentLevel]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  process.stdout.write(`${line}\n`);
}

export function logError(level: LogLevel, event: string, err: unknown, fields: LogFields = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  log(level, event, { ...fields, error: scrub(message) });
}
