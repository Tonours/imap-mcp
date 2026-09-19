import { buildRfc822 } from "./rfc822.js";

export interface MutationPolicy {
  enabled: boolean;
  perHour: number;
}

export interface MailSummary {
  uid: number;
  folder: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  seen: boolean;
}

export interface AttachmentInfo {
  filename: string;
  size: number;
  contentType: string;
}

export interface MailContent extends MailSummary {
  textPlain: string;
  textTruncated: boolean;
  htmlExcerpt: string;
  htmlOnly: boolean;
  attachments: AttachmentInfo[];
}

export interface FolderInfo {
  path: string;
  specialUse: string | null;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  unseen?: boolean;
  limit?: number;
}

export function parseCalendarDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`invalid ${field}: expected YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`invalid ${field}: ${value}`);
  }
  return date;
}

export function isCalendarDate(value: string): boolean {
  try {
    parseCalendarDate(value, "date");
    return true;
  } catch {
    return false;
  }
}

export interface MailInput {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  envelope: { from: string; to: string[] };
}

export interface SenderAdapter {
  send(input: MailInput): Promise<SendResult>;
}

export interface MailboxAdapter {
  health(): Promise<{ connected: boolean; host: string }>;
  listFolders(): Promise<FolderInfo[]>;
  search(folder: string, criteria: SearchCriteria): Promise<MailSummary[]>;
  get(folder: string, uid: number): Promise<MailContent>;
  appendDraft(rfc822: string): Promise<{ folder: string; uidValidity: number | null; uid: number | null }>;
  move(source: string, uid: number, destination: string): Promise<{ destinationUid: number | null }>;
  close(): Promise<void>;
}

export class MailNotFoundError extends Error {
  constructor(folder: string, uid: number) {
    super(`mail not found: folder=${folder} uid=${uid}`);
    this.name = "MailNotFoundError";
  }
}

export type MailAccountErrorCode =
  | "send_disabled"
  | "send_rate_limited"
  | "trash_disabled"
  | "trash_rate_limited"
  | "trash_folder_missing"
  | "trash_folder_ambiguous"
  | "already_in_trash"
  | "trash_move_failed";

export class MailAccountError extends Error {
  constructor(
    readonly code: MailAccountErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailAccountError";
  }
}

class RateGuard {
  private hits: number[] = [];

  constructor(private readonly perHour: number) {}

  tryAcquire(now: number = Date.now()): boolean {
    const windowStart = now - 3_600_000;
    this.hits = this.hits.filter((timestamp) => timestamp >= windowStart);
    if (this.hits.length >= this.perHour) return false;
    this.hits.push(now);
    return true;
  }
}

export interface MailAccountOptions {
  mailbox: MailboxAdapter;
  sender: SenderAdapter | null;
  from: string | null;
  sendPolicy: MutationPolicy;
  trashPolicy: MutationPolicy;
}

export interface TrashResult {
  sourceFolder: string;
  sourceUid: number;
  trashFolder: string;
  destinationUid: number | null;
}

export class MailAccount {
  private readonly sendGuard: RateGuard;
  private readonly trashGuard: RateGuard;

  constructor(private readonly options: MailAccountOptions) {
    this.sendGuard = new RateGuard(options.sendPolicy.perHour);
    this.trashGuard = new RateGuard(options.trashPolicy.perHour);
  }

  health() {
    return this.options.mailbox.health();
  }

  listFolders() {
    return this.options.mailbox.listFolders();
  }

  search(folder: string, criteria: SearchCriteria) {
    parseCalendarDate(criteria.since, "since");
    parseCalendarDate(criteria.before, "before");
    return this.options.mailbox.search(folder, criteria);
  }

  get(folder: string, uid: number) {
    return this.options.mailbox.get(folder, uid);
  }

  async send(input: Omit<MailInput, "from">): Promise<SendResult> {
    const { from, sender, sendPolicy } = this.options;
    if (!sendPolicy.enabled || !sender || !from) {
      throw new MailAccountError("send_disabled", "send capability is disabled");
    }
    if (!this.sendGuard.tryAcquire()) {
      throw new MailAccountError("send_rate_limited", "send mutation rate limit exceeded; retry later");
    }
    return sender.send({ ...input, from });
  }

  async createDraft(input: Omit<MailInput, "from">) {
    const { from, sendPolicy } = this.options;
    if (!sendPolicy.enabled || !from) {
      throw new MailAccountError("send_disabled", "send capability is disabled");
    }
    if (!this.sendGuard.tryAcquire()) {
      throw new MailAccountError("send_rate_limited", "send mutation rate limit exceeded; retry later");
    }
    return this.options.mailbox.appendDraft(buildRfc822({ ...input, from }));
  }

  async trash(sourceFolder: string, sourceUid: number): Promise<TrashResult> {
    if (!this.options.trashPolicy.enabled) {
      throw new MailAccountError("trash_disabled", "trash capability is disabled");
    }
    const [trash, extraTrash] = (await this.options.mailbox.listFolders()).filter(
      (folder) => folder.specialUse === "\\Trash",
    );
    if (!trash) {
      throw new MailAccountError("trash_folder_missing", "no folder marked with IMAP special-use \\Trash");
    }
    if (extraTrash) {
      throw new MailAccountError("trash_folder_ambiguous", "multiple folders are marked with IMAP special-use \\Trash");
    }
    const trashFolder = trash.path;
    if (sourceFolder === trashFolder) {
      throw new MailAccountError("already_in_trash", "source folder is already the trash folder");
    }
    if (!this.trashGuard.tryAcquire()) {
      throw new MailAccountError("trash_rate_limited", "trash mutation rate limit exceeded; retry later");
    }
    let moved: { destinationUid: number | null };
    try {
      moved = await this.options.mailbox.move(sourceFolder, sourceUid, trashFolder);
    } catch (error) {
      if (error instanceof MailNotFoundError) throw error;
      throw new MailAccountError("trash_move_failed", "IMAP MOVE to the trash folder failed", { cause: error });
    }
    return { sourceFolder, sourceUid, trashFolder, destinationUid: moved.destinationUid };
  }

  close() {
    return this.options.mailbox.close();
  }
}
