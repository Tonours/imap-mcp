import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MailAccount,
  MailAccountError,
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

class FakeMailbox implements MailboxAdapter {
  folders: FolderInfo[] = [
    { path: "INBOX", specialUse: "\\Inbox" },
    { path: "Trash", specialUse: "\\Trash" },
  ];
  moveResult: { destinationUid: number | null } | null = { destinationUid: 900 };
  moveError: Error | null = null;
  moveCalls: Array<{ source: string; uid: number; destination: string }> = [];

  async health() {
    return { connected: true, host: "imap.example.com" };
  }
  async listFolders() {
    return this.folders;
  }
  async search(_folder: string, _criteria: SearchCriteria): Promise<MailSummary[]> {
    return [];
  }
  async get(_folder: string, _uid: number): Promise<MailContent> {
    throw new Error("unused");
  }
  async appendDraft(_rfc822: string) {
    return { folder: "Drafts", uidValidity: 1, uid: 2 };
  }
  async move(source: string, uid: number, destination: string) {
    this.moveCalls.push({ source, uid, destination });
    if (this.moveError) throw this.moveError;
    if (this.moveResult === null) throw new MailNotFoundError(source, uid);
    return this.moveResult;
  }
  async close() {}
}

class FakeSender implements SenderAdapter {
  calls: MailInput[] = [];
  async send(input: MailInput): Promise<SendResult> {
    this.calls.push(input);
    return { messageId: "<id@example.com>", accepted: input.to, rejected: [], envelope: { from: input.from, to: input.to } };
  }
}

function account(overrides: Partial<ConstructorParameters<typeof MailAccount>[0]> = {}) {
  const mailbox = new FakeMailbox();
  const sender = new FakeSender();
  return {
    mailbox,
    sender,
    account: new MailAccount({
      mailbox,
      sender,
      from: "sender@example.com",
      sendPolicy: { enabled: false, perHour: 5 },
      trashPolicy: { enabled: false, perHour: 20 },
      ...overrides,
    }),
  };
}

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof MailAccountError && error.code === code);
}

describe("mail account mutation policies", () => {
  it("keeps send and trash enablement independent", async () => {
    const sendOnly = account({ sendPolicy: { enabled: true, perHour: 5 } });
    await sendOnly.account.send({ to: ["to@example.com"], cc: [], subject: "Subject", text: "Body" });
    await expectCode(() => sendOnly.account.trash("INBOX", 42), "trash_disabled");

    const trashOnly = account({ trashPolicy: { enabled: true, perHour: 20 } });
    await trashOnly.account.trash("INBOX", 42);
    await expectCode(
      () => trashOnly.account.send({ to: ["to@example.com"], cc: [], subject: "Subject", text: "Body" }),
      "send_disabled",
    );
  });

  it("moves one UID to the unique special-use trash folder", async () => {
    const state = account({ trashPolicy: { enabled: true, perHour: 20 } });
    const result = await state.account.trash("INBOX", 42);
    assert.deepEqual(result, { sourceFolder: "INBOX", sourceUid: 42, trashFolder: "Trash", destinationUid: 900 });
    assert.deepEqual(state.mailbox.moveCalls, [{ source: "INBOX", uid: 42, destination: "Trash" }]);
  });

  it("accepts a successful MOVE without UIDPLUS mapping", async () => {
    const state = account({ trashPolicy: { enabled: true, perHour: 20 } });
    state.mailbox.moveResult = { destinationUid: null };
    const result = await state.account.trash("INBOX", 42);
    assert.equal(result.destinationUid, null);
  });

  it("preserves a missing or stale UID as not_found", async () => {
    const state = account({ trashPolicy: { enabled: true, perHour: 20 } });
    state.mailbox.moveResult = null;
    await assert.rejects(
      () => state.account.trash("INBOX", 42),
      (error: unknown) => error instanceof MailNotFoundError,
    );
  });

  it("rejects zero, ambiguous and source-equals-trash targets before consuming rate", async () => {
    const state = account({ trashPolicy: { enabled: true, perHour: 1 } });
    state.mailbox.folders = [];
    await expectCode(() => state.account.trash("INBOX", 1), "trash_folder_missing");
    state.mailbox.folders = [
      { path: "Trash A", specialUse: "\\Trash" },
      { path: "Trash B", specialUse: "\\Trash" },
    ];
    await expectCode(() => state.account.trash("INBOX", 1), "trash_folder_ambiguous");
    state.mailbox.folders = [{ path: "Trash", specialUse: "\\Trash" }];
    await expectCode(() => state.account.trash("Trash", 1), "already_in_trash");
    state.mailbox.folders = [
      { path: "INBOX", specialUse: "\\Inbox" },
      { path: "Trash", specialUse: "\\Trash" },
    ];
    await state.account.trash("INBOX", 1);
  });

  it("consumes allowance once MOVE is attempted, including provider failure", async () => {
    const state = account({ trashPolicy: { enabled: true, perHour: 1 } });
    state.mailbox.moveError = new Error("provider failure");
    await expectCode(() => state.account.trash("INBOX", 1), "trash_move_failed");
    await expectCode(() => state.account.trash("INBOX", 2), "trash_rate_limited");
  });

  it("shares the send allowance with drafts without affecting trash", async () => {
    const state = account({
      sendPolicy: { enabled: true, perHour: 1 },
      trashPolicy: { enabled: true, perHour: 1 },
    });
    await state.account.send({ to: ["to@example.com"], cc: [], subject: "Subject", text: "Body" });
    await expectCode(
      () => state.account.createDraft({ to: ["to@example.com"], cc: [], subject: "Subject", text: "Body" }),
      "send_rate_limited",
    );
    await state.account.trash("INBOX", 42);
    await expectCode(() => state.account.trash("INBOX", 43), "trash_rate_limited");
  });
});
