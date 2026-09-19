import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const BASE_ENV = {
  MCP_AUTH_TOKEN: "config-test-token-0123456789",
  IMAP_HOST: "imap.example.com",
  IMAP_USER: "mailbox@example.com",
  IMAP_PASS: "imap-secret",
};

describe("provider-neutral configuration", () => {
  it("requires an explicit IMAP host", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, IMAP_HOST: "" }), /IMAP_HOST/);
  });

  it("starts read-only without SMTP settings", () => {
    const config = loadConfig(BASE_ENV);
    assert.equal(config.imap.host, "imap.example.com");
    assert.equal(config.smtp, null);
    assert.deepEqual(config.sendPolicy, { enabled: false, perHour: 5 });
    assert.deepEqual(config.trashPolicy, { enabled: false, perHour: 20 });
  });

  it("resolves distinct SMTP credentials and explicit STARTTLS", () => {
    const config = loadConfig({
      ...BASE_ENV,
      ALLOW_SEND: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "sender@example.com",
      SMTP_PASS: "smtp-secret",
      MAIL_FROM: "sender@example.com",
    });
    assert.deepEqual(config.smtp, {
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      user: "sender@example.com",
      pass: "smtp-secret",
      from: "sender@example.com",
    });
  });

  it("falls back to the complete IMAP credential pair only", () => {
    const config = loadConfig({
      ...BASE_ENV,
      ALLOW_SEND: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_SECURITY: "implicit",
    });
    assert.equal(config.smtp?.user, BASE_ENV.IMAP_USER);
    assert.equal(config.smtp?.pass, BASE_ENV.IMAP_PASS);
    assert.equal(config.smtp?.from, BASE_ENV.IMAP_USER);
    assert.throws(
      () =>
        loadConfig({
          ...BASE_ENV,
          ALLOW_SEND: "true",
          SMTP_HOST: "smtp.example.com",
          SMTP_SECURITY: "implicit",
          SMTP_USER: "sender@example.com",
        }),
      /SMTP_USER and SMTP_PASS/,
    );
  });

  it("rejects partial integers, invalid ports and non-boolean flags", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, IMAP_PORT: "993oops" }), /IMAP_PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, PORT: "0" }), /PORT/);
    assert.throws(() => loadConfig({ ...BASE_ENV, ALLOW_TRASH: "yes" }), /ALLOW_TRASH/);
    assert.throws(() => loadConfig({ ...BASE_ENV, LOG_LEVEL: "verbose" }), /LOG_LEVEL/);
  });

  it("keeps send and trash policies independent", () => {
    const config = loadConfig({ ...BASE_ENV, ALLOW_TRASH: "true", TRASH_RATE_PER_HOUR: "7" });
    assert.deepEqual(config.sendPolicy, { enabled: false, perHour: 5 });
    assert.deepEqual(config.trashPolicy, { enabled: true, perHour: 7 });
  });

  it("accepts provider usernames that are not email addresses", () => {
    const config = loadConfig({
      ...BASE_ENV,
      IMAP_USER: "account-id",
      ALLOW_SEND: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_SECURITY: "starttls",
      SMTP_USER: "smtp-account-id",
      SMTP_PASS: "smtp-secret",
      MAIL_FROM: "sender@example.com",
    });
    assert.equal(config.imap.user, "account-id");
    assert.equal(config.smtp?.user, "smtp-account-id");
    assert.equal(config.smtp?.from, "sender@example.com");
  });

  it("requires MAIL_FROM when the resolved SMTP username is not an address", () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE_ENV,
          IMAP_USER: "account-id",
          ALLOW_SEND: "true",
          SMTP_HOST: "smtp.example.com",
          SMTP_SECURITY: "implicit",
        }),
      /MAIL_FROM/,
    );
  });

  it("preserves password bytes exactly and rejects ambiguous token whitespace", () => {
    const config = loadConfig({
      ...BASE_ENV,
      IMAP_PASS: " imap-secret ",
      ALLOW_SEND: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_SECURITY: "implicit",
      SMTP_USER: "sender@example.com",
      SMTP_PASS: " smtp-secret ",
    });
    assert.equal(config.imap.pass, " imap-secret ");
    assert.equal(config.smtp?.pass, " smtp-secret ");
    assert.throws(
      () => loadConfig({ ...BASE_ENV, MCP_AUTH_TOKEN: " token-with-spaces-0123456789 " }),
      /leading or trailing whitespace/,
    );
  });
});
