import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeRuntime } from "../src/server.js";

describe("runtime shutdown", () => {
  it("waits for both HTTP and mailbox cleanup", async () => {
    let serverClosed = false;
    const server = {
      close(callback: (error?: Error) => void) {
        setTimeout(() => {
          serverClosed = true;
          callback();
        }, 5);
      },
    };
    let accountClosed = false;
    const account = {
      async close() {
        assert.equal(serverClosed, true, "HTTP must stop accepting and finish requests before IMAP closes");
        await new Promise((resolve) => setTimeout(resolve, 10));
        accountClosed = true;
      },
    };

    await closeRuntime(server, account, 1_000);

    assert.equal(accountClosed, true);
    assert.equal(serverClosed, true);
  });

  it("reports cleanup timeouts instead of exiting successfully", async () => {
    const server = { close(callback: (error?: Error) => void) { callback(); } };
    const account = { close: () => new Promise<void>(() => undefined) };
    await assert.rejects(() => closeRuntime(server, account, 5), /shutdown timed out/);
  });
});
