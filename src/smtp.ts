import { createTransport } from "nodemailer";
import type { MailInput, SenderAdapter, SendResult } from "./mail-account.js";
import type { SmtpSecurity } from "./config.js";

export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  pass: string;
}

interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
}

interface TransportResult {
  messageId: string;
  accepted?: unknown[];
  rejected?: unknown[];
  envelope: { from: unknown | false; to: unknown[] };
}

interface MailTransport {
  sendMail(message: OutgoingMessage): Promise<TransportResult>;
}

function toAddress(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "address" in value) {
    const address = value.address;
    if (typeof address === "string") return address;
  }
  return String(value);
}

export class SmtpSender implements SenderAdapter {
  private readonly transporter: MailTransport;

  constructor(settings: SmtpSettings, transporter?: MailTransport) {
    this.transporter =
      transporter ??
      createTransport({
        host: settings.host,
        port: settings.port,
        secure: settings.security === "implicit",
        requireTLS: settings.security === "starttls",
        auth: { user: settings.user, pass: settings.pass },
      });
  }

  async send(input: MailInput): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: input.from,
      to: input.to,
      cc: input.cc.length > 0 ? input.cc : undefined,
      subject: input.subject,
      text: input.text,
    });
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(toAddress),
      rejected: (info.rejected ?? []).map(toAddress),
      envelope: {
        from: info.envelope.from === false ? "" : toAddress(info.envelope.from),
        to: info.envelope.to.map(toAddress),
      },
    };
  }
}
