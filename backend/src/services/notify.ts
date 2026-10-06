import { MessageChannel, MessageStatus } from "@prisma/client";
import { config } from "../config/index.js";
import { prisma } from "../db/index.js";

// Outgoing messages (two-zone rebuild, Phase 5). Every SMS and email the
// system sends is a row in `message`, whatever the transport, so "was the
// visitor told?" always has an answer.
//
// Transports: "console" sends nothing; the message is readable on the
// Outbox page (and in the log), which is how links and codes are tested
// before the site's SMS and email providers are confirmed. A real transport
// will store the body with its secrets (codes, link tokens) redacted, so the
// outbox never becomes a way to read someone else's code.

interface Logger {
  info: (obj: object, msg: string) => void;
}

export interface OutgoingMessage {
  channel: MessageChannel;
  to: string;
  template: string;
  body: string;
  /** Substrings (codes, link tokens) never stored in clear by a real transport. */
  secrets?: string[];
  related?: { type: string; id: string };
}

export async function sendMessage(message: OutgoingMessage, log?: Logger) {
  const transport = config.messageTransport;
  let stored = message.body;
  if (transport !== "console") {
    for (const secret of message.secrets ?? []) stored = stored.split(secret).join("•".repeat(Math.min(secret.length, 8)));
  }
  // Only the console transport exists today, and it cannot fail.
  log?.info({ channel: message.channel, to: message.to, template: message.template, body: message.body }, "message (console transport — not sent)");
  return prisma.message.create({
    data: {
      channel: message.channel,
      recipient: message.to,
      template: message.template,
      body: stored,
      status: MessageStatus.SENT,
      transport,
      relatedType: message.related?.type ?? null,
      relatedId: message.related?.id ?? null,
    },
  });
}
