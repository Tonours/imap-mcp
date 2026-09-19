import { randomUUID } from "node:crypto";
import type { MailInput } from "./mail-account.js";

export const TEXT_MAX = 400_000;
export const SUBJECT_MAX = 998;

export function encodeSubject(subject: string): string {
  if (subject.length + 9 <= 990 && !/[^ -\u007e]/.test(subject)) return subject;
  const b64 = Buffer.from(subject, "utf8").toString("base64");
  const words: string[] = [];
  for (let i = 0; i < b64.length; i += 60) {
    words.push(`=?UTF-8?B?${b64.slice(i, i + 60)}?=`);
  }
  return words.join("\r\n ");
}

export function buildRfc822(input: MailInput): string {
  const domain = input.from.split("@")[1] ?? "localhost";
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = input.text.replace(/\r?\n/g, "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}
