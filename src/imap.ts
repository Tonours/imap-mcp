import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { logError } from "./logging.js";
import { MailNotFoundError, parseCalendarDate } from "./mail-account.js";
import type {
  FolderInfo,
  MailboxAdapter,
  MailContent,
  MailSummary,
  SearchCriteria,
} from "./mail-account.js";

export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 50;
const TEXT_CAP = 50_000;
const HTML_CAP = 2_000;
const HTML_INPUT_CAP = 200_000;
const SOURCE_CAP = 10_000_000;
const META_CAP = 1_000;
const ATTACHMENTS_CAP = 50;

interface AddressLike {
  address?: string;
  name?: string;
}

interface EnvelopeLike {
  subject?: string | null;
  from?: readonly AddressLike[] | null;
  to?: readonly AddressLike[] | null;
  date?: Date | string | null;
}

interface ImapSettings {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass: string;
  timeoutMs: number;
}

type SearchQuery = Parameters<ImapFlow["search"]>[0];

function addressToString(list: readonly AddressLike[] | null | undefined): string {
  if (!list || list.length === 0) return "";
  return list
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : (a.address ?? "")))
    .filter((s) => s !== "")
    .join(", ");
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function capMeta(value: string): string {
  return value.length > META_CAP ? `${value.slice(0, META_CAP)}…` : value;
}

function toSummary(folder: string, uid: number, env: EnvelopeLike, seen: boolean): MailSummary {
  const date = env.date instanceof Date ? env.date : new Date(String(env.date ?? ""));
  return {
    uid,
    folder,
    subject: capMeta(env.subject ?? ""),
    from: capMeta(addressToString(env.from)),
    to: capMeta(addressToString(env.to)),
    date: Number.isNaN(date.getTime()) ? "" : date.toISOString(),
    seen,
  };
}

export class ImapMailbox implements MailboxAdapter {
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;

  constructor(private readonly settings: ImapSettings) {}

  private timed<T>(promise: Promise<T>): Promise<T> {
    const ms = this.settings.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`imap operation timeout after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  private async ensure(): Promise<ImapFlow> {
    if (this.client && this.client.usable) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        await this.teardown();
        const client = new ImapFlow({
          host: this.settings.host,
          port: this.settings.port,
          secure: this.settings.tls,
          auth: { user: this.settings.user, pass: this.settings.pass },
          logger: false,
        });
        client.on("error", (err) => {
          if (this.client === client) this.client = null;
          logError("warn", "imap_error", err);
          client.close();
        });
        try {
          await this.timed(client.connect());
        } catch (err) {
          client.close();
          throw err;
        }
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await this.timed(client.logout());
    } catch {
      client.close();
    }
  }

  private async withMailbox<T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const attempt = async (): Promise<T> => {
      const client = await this.ensure();
      const lock = await this.timed(client.getMailboxLock(folder));
      try {
        return await this.timed(fn(client));
      } finally {
        lock.release();
      }
    };
    try {
      return await attempt();
    } catch (err) {
      const timeout = err instanceof Error && err.message.includes("timeout");
      if (!timeout && this.client?.usable) throw err;
      await this.teardown();
      return attempt();
    }
  }

  async health(): Promise<{ connected: boolean; host: string }> {
    try {
      const client = await this.ensure();
      await this.timed(client.noop());
      return { connected: true, host: this.settings.host };
    } catch {
      await this.teardown();
      return { connected: false, host: this.settings.host };
    }
  }

  async listFolders(): Promise<FolderInfo[]> {
    const folders = await this.withMailbox("INBOX", (client) => this.timed(client.list()));
    return folders.map((f) => ({ path: f.path, specialUse: f.specialUse ?? null }));
  }

  async search(folder: string, criteria: SearchCriteria): Promise<MailSummary[]> {
    const limit = Math.min(Math.max(criteria.limit ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
    return this.withMailbox(folder, async (client) => {
      const query: SearchQuery = {
        ...(criteria.from !== undefined ? { from: criteria.from } : {}),
        ...(criteria.to !== undefined ? { to: criteria.to } : {}),
        ...(criteria.subject !== undefined ? { subject: criteria.subject } : {}),
        ...(criteria.unseen !== undefined ? { seen: !criteria.unseen } : {}),
      };
      const since = parseCalendarDate(criteria.since, "since");
      const before = parseCalendarDate(criteria.before, "before");
      if (since) Object.assign(query, { since });
      if (before) Object.assign(query, { before });
      if (Object.keys(query).length === 0) Object.assign(query, { uid: "1:*" });

      const found = await client.search(query, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      const top = uids.slice(-limit).reverse();
      if (top.length === 0) return [];

      const summaries: MailSummary[] = [];
      for await (const msg of client.fetch(top.join(","), { envelope: true, flags: true }, { uid: true })) {
        if (msg.uid === undefined || msg.envelope === undefined) continue;
        const seen = msg.flags?.has("\\Seen") ?? true;
        summaries.push(toSummary(folder, msg.uid, msg.envelope, seen));
      }
      summaries.sort((a, b) => b.uid - a.uid);
      return summaries;
    });
  }

  async get(folder: string, uid: number): Promise<MailContent> {
    const meta = await this.withMailbox(folder, (client) =>
      this.timed(client.fetchOne(uid, { envelope: true, size: true, flags: true }, { uid: true })),
    );
    if (!meta || meta.envelope === undefined) {
      throw new MailNotFoundError(folder, uid);
    }
    const size = meta.size;
    if (size !== undefined && size > SOURCE_CAP) {
      throw new Error(`mail too large: ${size} bytes exceeds ${SOURCE_CAP} cap`);
    }
    const msg =
      size === 0
        ? { source: Buffer.alloc(0) }
        : await this.withMailbox(folder, (client) => this.timed(client.fetchOne(uid, { source: true }, { uid: true })));
    if (!msg || msg.source === undefined) {
      throw new MailNotFoundError(folder, uid);
    }
    if (msg.source.length > SOURCE_CAP) {
      throw new Error(`mail too large: ${msg.source.length} bytes exceeds ${SOURCE_CAP} cap`);
    }
    const parsed = await this.timed(simpleParser(msg.source));
    const rawHtml = typeof parsed.html === "string" ? parsed.html : "";
    const rawText = parsed.text ?? "";
    const htmlOnly = rawText.trim() === "" && rawHtml !== "";
    const body = htmlOnly ? htmlToText(rawHtml.slice(0, HTML_INPUT_CAP)) : rawText;
    const seen = meta.flags?.has("\\Seen") ?? true;

    return {
      ...toSummary(folder, uid, meta.envelope, seen),
      textPlain: body.slice(0, TEXT_CAP),
      textTruncated: body.length > TEXT_CAP || (htmlOnly && rawHtml.length > HTML_INPUT_CAP),
      htmlExcerpt: rawHtml.slice(0, HTML_CAP),
      htmlOnly,
      attachments: (parsed.attachments ?? []).slice(0, ATTACHMENTS_CAP).map((a) => ({
        filename: a.filename ?? "(sans nom)",
        size: a.size,
        contentType: a.contentType ?? "application/octet-stream",
      })),
    };
  }

  async appendDraft(rfc822: string): Promise<{ folder: string; uidValidity: number | null; uid: number | null }> {
    const folder = await this.resolveDraftsFolder();
    const result = await this.withMailbox(folder, (client) =>
      this.timed(client.append(folder, rfc822, ["\\Draft"])),
    );
    const info = typeof result === "object" && result !== null ? result : null;
    return {
      folder,
      uidValidity: info?.uidValidity != null ? Number(info.uidValidity) : null,
      uid: info?.uid != null ? Number(info.uid) : null,
    };
  }

  async move(source: string, uid: number, destination: string): Promise<{ destinationUid: number | null }> {
    const result = await this.withMailbox(source, (client) =>
      this.timed(client.messageMove(uid, destination, { uid: true })),
    );
    if (!result) throw new MailNotFoundError(source, uid);
    return { destinationUid: result.uidMap?.get(uid) ?? null };
  }

  private async resolveDraftsFolder(): Promise<string> {
    const folders = await this.withMailbox("INBOX", (client) => this.timed(client.list()));
    const bySpecialUse = folders.find((f) => f.specialUse === "\\Drafts");
    if (bySpecialUse) return bySpecialUse.path;
    const fallback = folders.find((f) => f.path === "INBOX.Drafts" || f.path === "Drafts");
    if (fallback) return fallback.path;
    throw new Error("no Drafts folder found");
  }

  async close(): Promise<void> {
    await this.teardown();
  }
}
