// Whiteboard images shared in a space. The app compresses an image (WebP,
// a few hundred KB at most) before uploading it here; whiteboard objects then
// carry the asset id and collaborators download it once into a local cache.
// Identical images are stored once per space.

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { badRequest, HttpError, notFound, requireUser, type Env } from "../lib/http.js";
import { membership } from "../lib/spaces.js";

const MIMES = new Set(["image/webp", "image/jpeg", "image/png"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks the bytes really are the claimed image type. */
export function sniff(b: Uint8Array): string | null {
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

const dim = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 && n < 100_000 ? n : null;
};

export const assets = new Hono<Env>();
assets.use("*", requireUser);

assets.post(
  "/:space/assets",
  bodyLimit({
    maxSize: config.limits.assetBytes,
    onError: () => {
      throw new HttpError(413, "too_large", "That image is too large to share, even after compression.");
    },
  }),
  async (c) => {
    const user = c.get("user");
    const spaceId = c.req.param("space");
    await membership(user.id, spaceId, "member");
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (!bytes.length) throw badRequest("The image is empty.");
    const mime = sniff(bytes);
    if (!mime || !MIMES.has(mime)) throw badRequest("Only WebP, JPEG and PNG images can be shared.");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const existing = await one<{ id: string }>("SELECT id FROM kern_asset WHERE space_id = $1 AND sha256 = $2", [spaceId, sha]);
    if (existing) return c.json({ id: existing.id, size: bytes.length, mime, existing: true });
    const used = await one<{ n: number }>("SELECT coalesce(sum(size), 0)::bigint AS n FROM kern_asset WHERE space_id = $1", [spaceId]);
    if ((used?.n ?? 0) + bytes.length > config.limits.assetQuotaBytes) {
      throw new HttpError(413, "quota", "This space has run out of image storage. Remove unused images from whiteboards, then try again.");
    }
    const row = await one<{ id: string }>(
      `INSERT INTO kern_asset(space_id, sha256, mime, size, width, height, bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (space_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING id`,
      [spaceId, sha, mime, bytes.length, dim(c.req.query("w")), dim(c.req.query("h")), Buffer.from(bytes), user.id],
    );
    return c.json({ id: row!.id, size: bytes.length, mime, existing: false }, 201);
  },
);

assets.get("/:space/assets/:id", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("space");
  const id = c.req.param("id");
  if (!UUID.test(id)) throw notFound("Image");
  await membership(user.id, spaceId);
  const row = await one<{ mime: string; bytes: Buffer }>("SELECT mime, bytes FROM kern_asset WHERE id = $1 AND space_id = $2", [id, spaceId]);
  if (!row) throw notFound("Image");
  return c.body(new Uint8Array(row.bytes), 200, {
    "Content-Type": row.mime,
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
});

/** Storage used by a space's images (shown in workspace management). */
assets.get("/:space/assets", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("space");
  await membership(user.id, spaceId);
  const r = await one<{ n: number; bytes: number }>("SELECT count(*)::int AS n, coalesce(sum(size), 0)::bigint AS bytes FROM kern_asset WHERE space_id = $1", [spaceId]);
  return c.json({ count: r?.n ?? 0, bytes: r?.bytes ?? 0, quota: config.limits.assetQuotaBytes });
});

/**
 * Deletes images no whiteboard object refers to any more. A week's grace
 * covers whiteboards in the trash and edits that haven't synced yet.
 */
export async function collectUnusedAssets(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM kern_asset a
     WHERE a.created_at < now() - interval '7 days'
       AND NOT EXISTS (
         SELECT 1 FROM kern_record r
         WHERE r.space_id = a.space_id AND r.tbl = 'wb_nodes' AND NOT r.deleted
           AND position(a.id::text IN r.data->>'data') > 0)
     RETURNING a.id`,
  );
  return rows.length;
}
