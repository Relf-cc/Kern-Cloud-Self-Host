// Outgoing email: verification and recovery codes, workspace invitations and
// security notices. Uses SMTP when configured, otherwise logs to stdout so a
// development server works without a mail provider.

import nodemailer from "nodemailer";
import { config } from "./config.js";
import { live } from "./live.js";

const transport = config.mailToConsole
  ? null
  : nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface Mail {
  to: string;
  subject: string;
  /** Plain-text version (always sent). */
  text: string;
  /** Body blocks rendered into the shared HTML layout. */
  html: string;
  /** Overrides the default From header, e.g. a personal note sent "from" a named person. */
  from?: string;
  /** Skips the branded card layout in favour of a plain, personal-letter look. */
  plain?: boolean;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
        <tr><td style="padding:28px 28px 8px 28px">
          <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(live.instanceName)}</div>
        </td></tr>
        <tr><td style="padding:8px 28px 28px 28px;font-size:14px;line-height:1.6">${body}</td></tr>
      </table>
      <div style="max-width:480px;padding:16px 8px;font-size:12px;color:#71717a;line-height:1.5">
        You're receiving this because of activity on your account at ${escapeHtml(live.instanceName)}. If it wasn't you, you can ignore this email.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

const h1 = (s: string) => `<h1 style="font-size:20px;line-height:1.3;margin:8px 0 12px 0;font-weight:600">${s}</h1>`;
const p = (s: string) => `<p style="margin:0 0 12px 0">${s}</p>`;
const muted = (s: string) => `<p style="margin:16px 0 0 0;font-size:12px;color:#71717a">${s}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:20px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>`;
const code = (otp: string) =>
  `<div style="margin:20px 0;padding:16px;border-radius:10px;background:#f4f4f5;text-align:center;font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:600;letter-spacing:0.3em">${escapeHtml(otp)}</div>`;

/** A plain, unbranded layout that reads like a personal email rather than a product notification. */
function plainLayout(body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;color:#18181b">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;padding:32px 20px">
        <tr><td style="font-size:15px;line-height:1.65">${body}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function send(mail: Mail): Promise<void> {
  if (!transport) {
    console.log(`[mail] (console) to=${mail.to} subject="${mail.subject}"\n${mail.text}\n`);
    return;
  }
  await transport.sendMail({
    from: mail.from ?? config.mail.from,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.plain ? plainLayout(mail.html) : layout(mail.subject, mail.html),
  });
}

/** Fire-and-forget send that logs failures (used where timing must not leak). */
export function sendLater(mail: Mail): void {
  void send(mail).catch((e) => console.error(`[mail] failed to send "${mail.subject}" to ${mail.to}:`, e));
}

export type OtpKind = "sign-in" | "email-verification" | "forget-password" | "change-email";

// Subjects name the instance (the server that sent the mail); the body says
// Kern, because the code is typed into the Kern app. A function rather than a
// constant: the instance name can change while the server runs, and a subject
// captured at import time would keep the old one.
const otpCopy = (): Record<OtpKind, { subject: string; title: string; lead: string }> => ({
  "email-verification": {
    subject: `Your ${live.instanceName} verification code`,
    title: "Confirm your email",
    lead: "Enter this code in Kern to confirm your email address and finish setting up your account.",
  },
  "sign-in": {
    subject: `Your ${live.instanceName} sign-in code`,
    title: "Sign in to Kern",
    lead: "Enter this code in Kern to sign in.",
  },
  "forget-password": {
    subject: `Reset your ${live.instanceName} password`,
    title: "Recover your account",
    lead: "Someone (hopefully you) asked to reset the password for this Kern account. Enter this code in Kern to choose a new password.",
  },
  "change-email": {
    subject: `Confirm your new email for ${live.instanceName}`,
    title: "Confirm your new email",
    lead: "Enter this code in Kern to move your account to this email address.",
  },
});

export function otpMail(to: string, otp: string, kind: OtpKind): Mail {
  const c = otpCopy()[kind];
  return {
    to,
    subject: c.subject,
    text: `${c.title}\n\n${c.lead}\n\nCode: ${otp}\n\nThe code expires in 10 minutes. If you didn't ask for it, ignore this email - your account is unchanged.`,
    html:
      h1(escapeHtml(c.title)) +
      p(escapeHtml(c.lead)) +
      code(otp) +
      muted("The code expires in 10 minutes. If you didn't ask for it, ignore this email - your account is unchanged."),
  };
}

export function inviteMail(opts: {
  to: string;
  inviter: string;
  workspace: string;
  role: string;
  message?: string | null;
  link: string;
  expiresAt: Date;
}): Mail {
  const expires = opts.expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const note = opts.message?.trim();
  return {
    to: opts.to,
    subject: `${opts.inviter} invited you to ${opts.workspace} on ${live.instanceName}`,
    text:
      `${opts.inviter} invited you to join the workspace "${opts.workspace}" on ${live.instanceName} as ${opts.role}.\n\n` +
      (note ? `"${note}"\n\n` : "") +
      `Accept the invitation: ${opts.link}\n\n` +
      `The link opens the Kern app. Sign in (or create an account) with ${opts.to} to join. It expires on ${expires}.`,
    html:
      h1(`Join ${escapeHtml(opts.workspace)}`) +
      p(`<strong>${escapeHtml(opts.inviter)}</strong> invited you to collaborate in the <strong>${escapeHtml(opts.workspace)}</strong> workspace on ${escapeHtml(live.instanceName)} as <strong>${escapeHtml(opts.role)}</strong>.`) +
      (note ? `<blockquote style="margin:0 0 12px 0;padding:8px 12px;border-left:3px solid #e4e4e7;color:#3f3f46">${escapeHtml(note)}</blockquote>` : "") +
      button(opts.link, "Accept invitation") +
      p(`The link opens the Kern app. Sign in, or create an account, with <strong>${escapeHtml(opts.to)}</strong> to join.`) +
      muted(`This invitation expires on ${escapeHtml(expires)}. Link not working? Paste this into your browser: ${escapeHtml(opts.link)}`),
  };
}

export function passwordChangedMail(to: string): Mail {
  return {
    to,
    subject: `Your ${live.instanceName} password was changed`,
    text: "The password for your Kern account was just changed and you've been signed out on your other devices.\n\nIf this wasn't you, reset your password straight away from the Kern sign-in screen (\"Forgot password\").",
    html:
      h1("Your password was changed") +
      p("The password for your Kern account was just changed, and you've been signed out on your other devices.") +
      p("If this wasn't you, reset your password straight away from the Kern sign-in screen using <strong>Forgot password</strong>."),
  };
}

const REPO_URL = "https://github.com/kern-platform/kern";

// The welcome email names the instance rather than a product vendor: on a
// self-hosted server the people signing up know the administrator, not us.
const link = (href: string, label = href) => `<a href="${escapeHtml(href)}" style="color:#18181b">${escapeHtml(label)}</a>`;
const list = (items: string[]) =>
  `<ul style="margin:0 0 12px 0;padding-left:20px">${items.map((i) => `<li style="margin:0 0 6px 0">${i}</li>`).join("")}</ul>`;

export function welcomeMail(to: string, name: string): Mail {
  const firstName = name.trim().split(/\s+/)[0] || "there";
  const instance = live.instanceName;
  const support = live.supportEmail;
  return {
    to,
    subject: `Welcome to ${instance}`,
    text:
      `Hi ${firstName},\n\n` +
      `Your account on ${instance} is ready. ${instance} is a self-hosted Kern server: it stores the spaces you sync, ` +
      `the workspaces you share, and nothing else. Your work still lives on your own computer - the account only adds ` +
      `syncing between your computers and collaborating with other people.\n\n` +
      `A few things to try:\n\n` +
      `- Your personal space now syncs between every computer you sign in on, and you can copy your offline work into it whenever you're ready.\n` +
      `- Create a workspace and invite people by email to plan together. Changes appear for everyone instantly, and whiteboards are multiplayer.\n` +
      `- Press Ctrl+K to find anything, or Ctrl+Shift+Space to capture a thought before it slips away.\n\n` +
      `Sign in from the Kern app with this server's address:\n${config.publicUrl}${config.basePath}\n\n` +
      (support ? `Questions about this server go to ${support}.\n\n` : "") +
      `Kern itself is open source: ${REPO_URL}\n`,
    html:
      h1(`Welcome to ${escapeHtml(instance)}`) +
      p(`Hi ${escapeHtml(firstName)},`) +
      p(
        `Your account on <strong>${escapeHtml(instance)}</strong> is ready. This is a self-hosted Kern server: it stores the ` +
          "spaces you sync and the workspaces you share, and nothing else. Your work still lives on your own computer - the " +
          "account only adds syncing between your computers and collaborating with other people.",
      ) +
      p("A few things to try:") +
      list([
        "<strong>Your personal space</strong> now syncs between every computer you sign in on, and you can copy your offline work into it whenever you're ready.",
        "<strong>Create a workspace</strong> and invite people by email to plan together. Changes appear for everyone instantly, and whiteboards are multiplayer.",
        "Press <strong>Ctrl+K</strong> to find anything, or <strong>Ctrl+Shift+Space</strong> to capture a thought before it slips away.",
      ]) +
      p(`Sign in from the Kern app with this server's address: ${link(`${config.publicUrl}${config.basePath}`)}`) +
      (support ? p(`Questions about this server? Email ${link(`mailto:${support}`, support)}.`) : "") +
      muted(`Kern is open source - the code is on ${link(REPO_URL, "GitHub")}.`),
  };
}

export function streamMail(opts: {
  to: string;
  stream: string;
  space: string;
  status: "delivered" | "partial" | "failed";
  title: string;
  preview: string;
  issueUrl: string | null;
  problem: string | null;
}): Mail {
  const failed = opts.status !== "delivered";
  const what = opts.status === "failed" ? "couldn't be delivered" : opts.status === "partial" ? "was only partly delivered" : "arrived";
  const preview = opts.preview.length > 600 ? `${opts.preview.slice(0, 600)}…` : opts.preview;
  return {
    to: opts.to,
    subject: failed ? `Stream "${opts.stream}": a submission ${what}` : `New in ${opts.stream}: ${opts.title}`.slice(0, 160),
    text:
      `A submission to the stream "${opts.stream}" in ${opts.space} ${what}.\n\n` +
      `${opts.title}\n\n${preview}\n\n` +
      (opts.problem ? `Problem: ${opts.problem}\n\n` : "") +
      (opts.issueUrl ? `GitHub issue: ${opts.issueUrl}\n\n` : "") +
      `Open Kern to see it. You can change these emails in the stream's notification settings.`,
    html:
      h1(escapeHtml(failed ? `A submission ${what}` : opts.title)) +
      p(`Stream <strong>${escapeHtml(opts.stream)}</strong> in <strong>${escapeHtml(opts.space)}</strong>.`) +
      (failed ? p(`<strong>${escapeHtml(opts.title)}</strong>`) : "") +
      (preview
        ? `<blockquote style="margin:0 0 12px 0;padding:8px 12px;border-left:3px solid #e4e4e7;color:#3f3f46;white-space:pre-wrap">${escapeHtml(preview)}</blockquote>`
        : "") +
      (opts.problem ? p(`<span style="color:#b91c1c">${escapeHtml(opts.problem)}</span>`) : "") +
      (opts.issueUrl ? button(opts.issueUrl, "Open the GitHub issue") : "") +
      muted("Open Kern to see the delivery log. You can change these emails in the stream's notification settings."),
  };
}
