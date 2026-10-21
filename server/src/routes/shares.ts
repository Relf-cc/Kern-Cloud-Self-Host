// Share links: a read-only snapshot of a note, whiteboard or project that
// the owner publishes from the app (<LINK_URL>/kern/s/<id>). Each
// item has at most one live link; publishing again updates it in place.
// Links can expire and can be turned off at any time. Pages are rendered
// here from structured content with everything escaped, and run no scripts.

import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { badRequest, body, conflict, HttpError, iso, notFound, requireUser, requireVerified, type Env } from "../lib/http.js";
import { fmtDate, page, PAGE_CSP, renderMarkdown, renderProject, type ProjectShare } from "../lib/pages.js";
import { escapeHtml } from "../mail.js";

export const shares = new Hono<Env>();
export const sharePages = new Hono();

const SHARE_ID = /^[A-Za-z0-9_-]{22}$/;
const IMAGE_TYPES = new Set(["image/png", "image/webp", "image/jpeg"]);

interface ShareRow {
  id: string;
  owner_id: string;
  kind: "note" | "whiteboard" | "project";
  ref_id: string;
  title: string;
  content: Record<string, unknown>;
  image_mime: string | null;
  views: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = "id, owner_id, kind, ref_id, title, content, image_mime, views, created_at, updated_at, expires_at, revoked_at";

export const shareUrl = (id: string) => `${config.linkUrl}/kern/s/${id}`;

function serialize(r: ShareRow) {
  return {
    id: r.id,
    url: shareUrl(r.id),
    kind: r.kind,
    refId: r.ref_id,
    title: r.title,
    views: r.views,
    hasImage: !!r.image_mime,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    expiresAt: iso(r.expires_at),
  };
}

const noteContent = z.object({ markdown: z.string().max(400_000) });
const whiteboardContent = z.object({ width: z.number().int().positive().max(20_000).optional(), height: z.number().int().positive().max(20_000).optional(), objects: z.number().int().min(0).optional() });
const projectContent = z.object({
  description: z.string().max(20_000).optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  done: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
  milestones: z.array(z.object({ title: z.string().max(300), targetDate: z.string().max(10).nullable().optional(), status: z.string().max(20).optional(), progress: z.number().min(0).max(1).optional() })).max(200).optional(),
  tasks: z.array(z.object({ title: z.string().max(500), status: z.string().max(20).optional(), dueDate: z.string().max(10).nullable().optional(), group: z.string().max(100).nullable().optional() })).max(1000).optional(),
});

const publishBody = z.object({
  kind: z.enum(["note", "whiteboard", "project"]),
  refId: z.string().min(1).max(100),
  title: z.string().trim().max(300).default(""),
  content: z.record(z.string(), z.unknown()).default({}),
  /** Base64 image (whiteboards). */
  image: z.string().max(8 * 1024 * 1024).optional(),
  imageMime: z.string().optional(),
  /** null keeps the link until it's turned off. */
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
});

shares.use("*", requireUser);

shares.get("/", async (c) => {
  const user = c.get("user");
  const rows = await query<ShareRow>(`SELECT ${COLUMNS} FROM kern_share WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY updated_at DESC`, [user.id]);
  return c.json({ shares: rows.map(serialize) });
});

shares.put(
  "/",
  bodyLimit({
    maxSize: 10 * 1024 * 1024,
    onError: () => {
      throw new HttpError(413, "too_large", "That's too large to share.");
    },
  }),
  async (c) => {
    const user = c.get("user");
    requireVerified(user);
    const input = await body(c, publishBody);
    const schema = input.kind === "note" ? noteContent : input.kind === "whiteboard" ? whiteboardContent : projectContent;
    const parsed = schema.safeParse(input.content);
    if (!parsed.success) throw badRequest(`content: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const content = JSON.stringify(parsed.data);
    if (content.length > config.shares.contentBytes) throw new HttpError(413, "too_large", "That's too large to share.");
    let image: Buffer | null = null;
    if (input.image) {
      if (!input.imageMime || !IMAGE_TYPES.has(input.imageMime)) throw badRequest("Images are PNG, WebP or JPEG.");
      image = Buffer.from(input.image, "base64");
      if (image.length > config.shares.imageBytes) throw new HttpError(413, "too_large", "That image is too large to share.");
    }
    if (input.kind === "whiteboard" && !image) throw badRequest("A shared whiteboard needs its image.");
    const expires = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
    const title = input.title || (input.kind === "note" ? "Untitled note" : input.kind === "whiteboard" ? "Whiteboard" : "Project");
    const existing = await one<{ id: string }>("SELECT id FROM kern_share WHERE owner_id = $1 AND kind = $2 AND ref_id = $3 AND revoked_at IS NULL", [user.id, input.kind, input.refId]);
    let row: ShareRow | null;
    if (existing) {
      row = await one<ShareRow>(
        `UPDATE kern_share SET title = $2, content = $3::jsonb, image = coalesce($4, CASE WHEN kind = 'whiteboard' THEN image ELSE NULL END),
           image_mime = coalesce($5, CASE WHEN kind = 'whiteboard' THEN image_mime ELSE NULL END),
           expires_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE expires_at END, updated_at = now()
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [existing.id, title, content, image, image ? input.imageMime : null, input.expiresInDays !== undefined, expires],
      );
    } else {
      const n = await one<{ n: number }>("SELECT count(*)::int AS n FROM kern_share WHERE owner_id = $1 AND revoked_at IS NULL", [user.id]);
      if ((n?.n ?? 0) >= config.shares.perUser) throw conflict(`You can have up to ${config.shares.perUser} share links. Turn some off first.`, "limit");
      const id = randomBytes(16).toString("base64url");
      row = await one<ShareRow>(
        `INSERT INTO kern_share(id, owner_id, kind, ref_id, title, content, image, image_mime, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         RETURNING ${COLUMNS}`,
        [id, user.id, input.kind, input.refId, title, content, image, image ? input.imageMime : null, expires],
      );
    }
    return c.json({ share: serialize(row!) });
  },
);

shares.get("/for/:kind/:refId", async (c) => {
  const user = c.get("user");
  const row = await one<ShareRow>(`SELECT ${COLUMNS} FROM kern_share WHERE owner_id = $1 AND kind = $2 AND ref_id = $3 AND revoked_at IS NULL`, [user.id, c.req.param("kind"), c.req.param("refId")]);
  return c.json({ share: row ? serialize(row) : null });
});

shares.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!SHARE_ID.test(id)) throw notFound("Share link");
  const r = await one<{ id: string }>("UPDATE kern_share SET revoked_at = now(), image = NULL, content = '{}'::jsonb WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL RETURNING id", [id, user.id]);
  if (!r) throw notFound("Share link");
  return c.json({ ok: true });
});

// ------------------------------------------------------------ public pages

async function live(id: string): Promise<ShareRow | null> {
  if (!SHARE_ID.test(id)) return null;
  return one<ShareRow>(`SELECT ${COLUMNS} FROM kern_share WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [id]);
}

function gone(c: Context) {
  c.header("Content-Security-Policy", PAGE_CSP);
  return c.html(page("Link not available", `<div class="card"><h1 class="title">This link isn't available</h1><p class="meta">It may have expired or been turned off by its owner.</p></div>`), 404);
}

sharePages.get("/kern/s/:id", async (c) => {
  const row = await live(c.req.param("id"));
  if (!row) return gone(c);
  await query("UPDATE kern_share SET views = views + 1 WHERE id = $1", [row.id]);
  const updated = `Updated ${row.updated_at.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`;
  const head = (extra = "") => `<header><h1 class="title">${escapeHtml(row.title)}</h1><div class="meta">${extra}${updated}</div></header>`;
  let body: string;
  if (row.kind === "note") {
    const md = typeof row.content.markdown === "string" ? row.content.markdown : "";
    body = `${head()}<article class="card prose">${renderMarkdown(md) || '<p class="meta">This note is empty.</p>'}</article>`;
  } else if (row.kind === "whiteboard") {
    const w = Number(row.content.width) || undefined;
    const h = Number(row.content.height) || undefined;
    const size = w && h ? ` width="${w}" height="${h}"` : "";
    body = `${head()}<div class="card" style="padding:12px"><img class="board" src="/kern/s/${row.id}/image?v=${row.updated_at.getTime()}" alt="${escapeHtml(row.title)}"${size}></div>`;
  } else {
    const p = row.content as ProjectShare;
    const today = new Date().toISOString().slice(0, 10);
    body = `${head(p.targetDate ? `Target ${escapeHtml(fmtDate(p.targetDate))} · ` : "")}<div class="card">${renderProject(p, today)}</div>`;
  }
  c.header("Content-Security-Policy", PAGE_CSP);
  c.header("Cache-Control", "no-store");
  return c.html(page(row.title, body, { description: row.kind === "note" ? String(row.content.markdown ?? "").slice(0, 200) : undefined }));
});

sharePages.get("/kern/s/:id/image", async (c) => {
  const id = c.req.param("id");
  if (!SHARE_ID.test(id)) return c.body(null, 404);
  const r = await one<{ image: Buffer | null; image_mime: string | null }>(
    "SELECT image, image_mime FROM kern_share WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
    [id],
  );
  if (!r?.image || !r.image_mime) return c.body(null, 404);
  c.header("Content-Type", r.image_mime);
  c.header("Cache-Control", "private, max-age=300");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(new Uint8Array(r.image));
});
