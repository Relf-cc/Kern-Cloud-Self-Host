// Cloudflare Email Worker for Kern's email-to-stream addresses
// (<alias>@in.your-server.example). Cloudflare Email Routing hands every message for
// the inbound domain to this worker; it parses the message and posts the
// essentials to Kern Cloud, which delivers it to the stream (usually the
// Inbox). See ../../README.md → "Email to streams".
//
// Environment: KERN_INBOUND_URL (http://localhost:8787/kern/v1/inbound/email)
// and the secret KERN_INBOUND_SECRET (same value as the server's
// INBOUND_EMAIL_SECRET).

import PostalMime from "postal-mime";

const MAX_TEXT = 20_000;

/** A readable plain-text body, from the text part or a stripped HTML part. */
function textOf(email) {
  if (email.text && email.text.trim()) return email.text;
  if (!email.html) return "";
  return email.html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export default {
  async email(message, env) {
    if (message.rawSize > 5 * 1024 * 1024) {
      message.setReject("Message too large for Kern (5 MB at most).");
      return;
    }
    const email = await PostalMime.parse(message.raw);
    const res = await fetch(env.KERN_INBOUND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.KERN_INBOUND_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({
        to: message.to,
        from: message.from,
        subject: email.subject ?? "",
        text: textOf(email).slice(0, MAX_TEXT),
        messageId: email.messageId ?? message.headers.get("message-id"),
      }),
    });
    if (res.ok) return;
    // Permanent refusals bounce back to the sender; anything else is retried.
    if (res.status === 404) message.setReject("There's no Kern address like that.");
    else if (res.status === 403) message.setReject("This Kern address doesn't accept mail from you.");
    else if (res.status === 413 || res.status === 422) message.setReject("Kern couldn't accept this message.");
    else throw new Error(`Kern Cloud answered ${res.status}`);
  },
};
