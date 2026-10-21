// Shareable links. There's no website: an invite link
// (<LINK_URL>/kern/invite/<uuid>) answers with a tiny hand-off page that
// immediately opens the desktop app through its URL scheme
// (kern://invite/<uuid>), with a fallback button and a download link for
// people who don't have Kern yet.

import { Hono } from "hono";
import { config } from "../config.js";
import { escapeHtml } from "../mail.js";
import { inviteSummary } from "./workspaces.js";

export const links = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title: string, body: string, deepLink?: string) {
  const open = deepLink ? `<script>setTimeout(function(){location.href=${JSON.stringify(deepLink)}},150)</script>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--card:#fff;--text:#18181b;--muted:#71717a;--line:#e4e4e7;--btn:#18181b;--btn-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#1a1a1a;--text:#f4f4f5;--muted:#a1a1aa;--line:#2a2a2a;--btn:#f4f4f5;--btn-text:#111}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;text-align:center}
.logo{width:56px;height:56px;border-radius:12px;object-fit:cover;margin:0 auto 12px;display:block;border:1px solid var(--line)}
.mark{width:56px;height:56px;border-radius:12px;margin:0 auto 12px;display:grid;place-items:center;font-weight:700;font-size:22px;background:var(--bg);border:1px solid var(--line)}
h1{font-size:18px;margin:0 0 6px}p{margin:0 0 14px;color:var(--muted)}
a.btn{display:inline-block;background:var(--btn);color:var(--btn-text);text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin-top:6px}
a.sub{display:block;margin-top:14px;color:var(--muted);font-size:13px}
</style></head><body><main class="card">${body}</main>${open}</body></html>`;
}

links.get("/kern/invite/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.html(page("Invitation not found", `<h1>Invitation not found</h1><p>Check the link in your email.</p>`), 404);
  const inv = await inviteSummary(id);
  if (!inv) return c.html(page("Invitation not found", `<h1>Invitation not found</h1><p>Check the link in your email, or ask for a new invitation.</p>`), 404);
  const deepLink = `${config.appScheme}://invite/${id}`;
  const name = escapeHtml(inv.workspace);
  const mark = inv.logo ? `<img class="logo" src="${escapeHtml(inv.logo)}" alt="">` : `<div class="mark">${escapeHtml(inv.workspace.slice(0, 1).toUpperCase())}</div>`;
  if (inv.status !== "pending") {
    const why = inv.status === "expired" ? "This invitation has expired." : inv.status === "accepted" ? "This invitation has already been accepted." : "This invitation is no longer valid.";
    return c.html(page(`Invitation to ${inv.workspace}`, `${mark}<h1>${name}</h1><p>${why} ${inv.status === "accepted" ? "" : "Ask a workspace admin to invite you again."}</p>${inv.status === "accepted" ? `<a class="btn" href="${escapeHtml(deepLink)}">Open Kern</a>` : ""}`), 410);
  }
  const by = inv.inviterName ? `${escapeHtml(inv.inviterName)} invited you` : "You're invited";
  return c.html(
    page(
      `Join ${inv.workspace} on Kern`,
      `${mark}<h1>Join ${name}</h1><p>${by} to collaborate as ${escapeHtml(inv.role)}. Opening Kern…</p>
       <a class="btn" href="${escapeHtml(deepLink)}">Open in Kern</a>
       <a class="sub" href="${escapeHtml(config.downloadUrl)}">Don't have Kern yet? Download it, then open this link again.</a>`,
      deepLink,
    ),
  );
});

/** Invitation details for the app (no sign-in needed; the id is the secret). */
links.get(`${config.basePath}/invites/:id`, async (c) => {
  const inv = await inviteSummary(c.req.param("id"));
  if (!inv) return c.json({ code: "not_found", message: "That invitation wasn't found." }, 404);
  return c.json(inv);
});
