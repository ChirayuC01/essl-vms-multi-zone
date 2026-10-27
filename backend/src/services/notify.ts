import { MessageChannel, MessageStatus } from "@prisma/client";
import nodemailer from "nodemailer";
import { prisma } from "../db/index.js";
import { getBranding } from "./branding.js";
import { getSettings, type SiteSettings, type SmsTemplateKey } from "./settings.js";

// Outgoing messages (two-zone rebuild, Phase 5; MSG91 and SMTP, Oct 2026).
// Every SMS and every sent email is a row in `message`, whatever the
// transport, so "was the visitor told?" always has an answer.
//
// SMS: "console" sends nothing; the message is readable on the Outbox page
// (and in the log). "msg91" sends the full text through MSG91's sendsms API
// with the site's sender ID and the template's DLT ID; nothing is set up
// inside MSG91. The text (wording below + the site's signature) must match
// the DLT registration character for character.
// Email: off by default; when on, sent over the site's SMTP server.
//
// A real transport stores the body with its secrets (codes, link tokens)
// redacted, so the outbox never becomes a way to read someone else's code.

/**
 * The DLT-registered wording, minus the signature, one `{#}` per variable.
 * It must match the registration character for character: change it only
 * together with a new DLT registration.
 */
export const SMS_TEXT: Record<SmsTemplateKey, string> = {
  MOBILE_OTP: "{#} is your code to confirm your visit to {#}. It expires in {#} minutes. Do not share it.",
  VISIT_LINK_INVITE: "{#} has invited you to {#} on {#}. Please complete your details before you arrive: {#}. Form valid until {#}.",
  VISIT_LINK_QUERY: '{#} at {#} needs a change to your visit details: "{#}". Please complete your details before you arrive: {#} (valid until {#}).',
  VISIT_CONFIRMED: "Your visit to {#} on {#} is confirmed. At the entry gate, simply look at the camera.",
  VISIT_REJECTED: "Your visit request to {#} for {#} was not approved. Please contact your host.",
  OUT_PASS: "Your visit to {#} is registered. To obtain your exit pass when leaving, open {#} and enter the exit code provided by {#}.",
  EXIT_CODE: "{#} has arrived at {#}. Their exit code is {#} — give it to them when the visit ends.",
  REQUEST_SUBMITTED_WALK_IN: "{#} is at the gate to see you. Please review the request in the visitor console.",
  REQUEST_SUBMITTED_PLANNED: "{#} has submitted their details for the visit on {#}. Please review the request in the visitor console.",
  REQUEST_SUBMITTED_AUTO_FAILED: "{#}'s pass could not be issued automatically ({#}). Please review the request in the visitor console.",
  PASS_ISSUED: "{#} has been issued a pass to visit you ({#}).",
};

/** The Outbox groups the split templates under the message they belong to. */
const OUTBOX_NAME: Partial<Record<SmsTemplateKey, string>> = {
  VISIT_LINK_INVITE: "VISIT_LINK",
  VISIT_LINK_QUERY: "VISIT_LINK",
  REQUEST_SUBMITTED_WALK_IN: "REQUEST_SUBMITTED",
  REQUEST_SUBMITTED_PLANNED: "REQUEST_SUBMITTED",
  REQUEST_SUBMITTED_AUTO_FAILED: "REQUEST_SUBMITTED",
};

// DLT refuses a variable value longer than 30 characters. Links are exempt
// (registered as URL variables).
const DLT_VAR_MAX = 30;
export const fitVar = (v: string) => (/^https?:\/\//.test(v) || v.length <= DLT_VAR_MAX ? v : v.slice(0, DLT_VAR_MAX).trimEnd());

/** Fill a template's `{#}` slots in order and add the site's signature. Pure, for tests. */
export function renderSms(template: SmsTemplateKey, vars: string[], signature = ""): string {
  let i = 0;
  return SMS_TEXT[template].replace(/\{#\}/g, () => vars[i++] ?? "") + signature;
}

/** MSG91 wants the country code; a bare 10-digit number is taken as Indian. */
// ponytail: India-only default; make the country code a setting when a site abroad appears.
export const msg91Mobile = (mobile: string) => {
  const digits = mobile.replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
};

interface Logger {
  info: (obj: object, msg: string) => void;
}

export interface OutgoingMessage {
  channel: MessageChannel;
  to: string;
  template: SmsTemplateKey;
  vars: string[];
  /** Substrings (codes, link tokens) never stored in clear by a real transport. */
  secrets?: string[];
  related?: { type: string; id: string };
}

async function sendMsg91(s: SiteSettings, template: SmsTemplateKey, to: string, text: string) {
  const dltId = s.dltTemplateIds[template];
  if (!dltId) throw new Error(`no DLT template ID for ${template} in Settings`);
  const res = await fetch("https://api.msg91.com/api/v2/sendsms", {
    method: "POST",
    headers: { authkey: s.msg91AuthKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: s.msg91SenderId,
      route: "4",
      DLT_TE_ID: dltId,
      // Anything outside ASCII (template 7's em dash) needs a Unicode SMS.
      ...(/[^\x00-\x7F]/.test(text) ? { unicode: 1 } : {}),
      sms: [{ message: text, to: [msg91Mobile(to)] }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const reply = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
  if (!res.ok || reply.type === "error") throw new Error(`MSG91 ${res.status}: ${reply.message ?? "no reason given"}`);
}

async function sendEmail(s: SiteSettings, to: string, body: string) {
  const { organizationName } = await getBranding();
  const transport = nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    auth: s.smtpUser ? { user: s.smtpUser, pass: s.smtpPassword } : undefined,
    connectionTimeout: 15_000,
  });
  await transport.sendMail({ from: s.smtpFrom, to, subject: `${organizationName}: visitor access`, text: body });
}

/**
 * Send one message and record it. Never throws for a delivery failure: the
 * row is stored FAILED with the reason, and the caller's work (a link, a
 * code) stands. Email while email is off is neither sent nor recorded.
 */
export async function sendMessage(message: OutgoingMessage, log?: Logger) {
  const settings = await getSettings();
  const isSms = message.channel === MessageChannel.SMS;
  if (!isSms && !settings.emailEnabled) return null;
  const vars = message.vars.map(fitVar);
  const body = renderSms(message.template, vars, settings.smsSignature);
  const transport = isSms ? settings.smsTransport : "smtp";

  let error: string | null = null;
  try {
    if (transport === "msg91") await sendMsg91(settings, message.template, message.to, body);
    else if (transport === "smtp") await sendEmail(settings, message.to, body);
    else log?.info({ channel: message.channel, to: message.to, template: message.template, body }, "message (console transport — not sent)");
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }

  let stored = body;
  if (transport !== "console") {
    for (const secret of message.secrets ?? []) stored = stored.split(secret).join("•".repeat(Math.min(secret.length, 8)));
  }
  return prisma.message.create({
    data: {
      channel: message.channel,
      recipient: message.to,
      template: OUTBOX_NAME[message.template] ?? message.template,
      body: stored,
      status: error ? MessageStatus.FAILED : MessageStatus.SENT,
      error,
      transport,
      relatedType: message.related?.type ?? null,
      relatedId: message.related?.id ?? null,
    },
  });
}
