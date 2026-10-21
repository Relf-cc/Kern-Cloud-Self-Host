// Record sync for a space.
//
// Clients push changes as field-level patches ("upsert" with only the columns
// that changed, or the full row for new records) and deletions. The server
// merges patches into the stored row (last writer wins per field), assigns
// each change the next sequence number of the space, and broadcasts the
// merged rows to everyone subscribed. Pulls return rows changed after a
// cursor, in sequence order.
//
// Sequence numbers are allocated under a row lock on the space, so they are
// contiguous within a push and commit in order: a client that has applied
// everything up to N can apply a broadcast starting at N + 1 directly, and
// otherwise pulls.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { one, query, tx } from "../db.js";
import { badRequest, body, HttpError, requireUser, type Env } from "../lib/http.js";
import { membership } from "../lib/spaces.js";
import { broadcastSpace } from "../realtime.js";

/** Tables the app syncs. Anything else is device-local and never uploaded. */
export const SYNCED_TABLES = new Set([
  "project_groups",
  "projects",
  "labels",
  "boards",
  "board_columns",
  "tasks",
  "task_labels",
  "task_relations",
  "notes",
  "inbox_items",
  "whiteboards",
  "wb_nodes",
  "wb_edges",
  "milestones",
  "milestone_deps",
  "release_links",
  "project_repos",
  "task_issue_links",
  "task_comments",
  "templates",
  "habits",
  "habit_checks",
]);

const MAX_RECORD_BYTES = 512 * 1024;

const change = z.object({
  t: z.string().refine((t) => SYNCED_TABLES.has(t), "unknown table"),
  id: z.string().min(1).max(300),
  op: z.enum(["upsert", "delete"]),
  /** True when `data` is the complete row (a new record), not a patch. */
  full: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const pushBody = z.object({
  /** Identifies the pushing connection so it can skip its own echo. */
  conn: z.string().max(64).optional(),
  changes: z.array(change).max(config.limits.pushChanges),
});

export interface OutChange {
  seq: number;
  t: string;
  id: string;
  op: "upsert" | "delete";
  data: Record<string, unknown> | null;
}

export interface InChange {
  t: string;
  id: string;
  op: "upsert" | "delete";
  full?: boolean;
  data?: Record<string, unknown>;
}

/**
 * Commits changes to a space inside the caller's transaction (sync pushes,
 * and records created by streams). The space row is locked and a contiguous
 * block of sequence numbers is reserved; the caller broadcasts the result
 * after committing.
 */
export async function writeChanges(db: PoolClient, spaceId: string, actor: string, changes: InChange[]) {
  if (!changes.length) {
    const s = await one<{ seq: number }>("SELECT seq FROM kern_space WHERE id = $1", [spaceId], db);
    return { from: s!.seq + 1, to: s!.seq, changes: [] as OutChange[], rejected: [] as OutChange[] };
  }
  const locked = await one<{ seq: number }>("SELECT seq FROM kern_space WHERE id = $1 FOR UPDATE", [spaceId], db);
  let seq = locked!.seq;
  const from = seq + 1;
  const out: OutChange[] = [];
  const rejected: OutChange[] = [];
  for (const ch of changes) {
    if (ch.op === "delete") {
      seq++;
      const row = await one<{ seq: number }>(
        `INSERT INTO kern_record(space_id, tbl, id, data, deleted, seq, updated_by) VALUES ($1, $2, $3, '{}'::jsonb, true, $4, $5)
         ON CONFLICT (space_id, tbl, id) DO UPDATE SET data = '{}'::jsonb, deleted = true, seq = EXCLUDED.seq, updated_at = now(), updated_by = EXCLUDED.updated_by
         RETURNING seq`,
        [spaceId, ch.t, ch.id, seq, actor],
        db,
      );
      out.push({ seq: row!.seq, t: ch.t, id: ch.id, op: "delete", data: null });
      continue;
    }
    const existing = await one<{ deleted: boolean }>("SELECT deleted FROM kern_record WHERE space_id = $1 AND tbl = $2 AND id = $3", [spaceId, ch.t, ch.id], db);
    if (existing?.deleted && !ch.full) {
      // A patch for something deleted elsewhere: deletion wins; tell the
      // client so it removes its copy.
      rejected.push({ seq: 0, t: ch.t, id: ch.id, op: "delete", data: null });
      continue;
    }
    seq++;
    const row = await one<{ seq: number; data: Record<string, unknown> }>(
      `INSERT INTO kern_record(space_id, tbl, id, data, deleted, seq, updated_by) VALUES ($1, $2, $3, $4::jsonb, false, $5, $6)
       ON CONFLICT (space_id, tbl, id) DO UPDATE SET
         data = CASE WHEN kern_record.deleted OR $7 THEN EXCLUDED.data ELSE kern_record.data || EXCLUDED.data END,
         deleted = false, seq = EXCLUDED.seq, updated_at = now(), updated_by = EXCLUDED.updated_by
       RETURNING seq, data`,
      [spaceId, ch.t, ch.id, JSON.stringify(ch.data), seq, actor, !!ch.full],
      db,
    );
    out.push({ seq: row!.seq, t: ch.t, id: ch.id, op: "upsert", data: row!.data });
  }
  // Rejected patches don't consume numbers, so the block stays contiguous.
  await query("UPDATE kern_space SET seq = $2, updated_at = now() WHERE id = $1", [spaceId, seq], db);
  return { from, to: seq, changes: out, rejected };
}

export const sync = new Hono<Env>();
sync.use("*", requireUser);

sync.post(
  "/:space/sync/push",
  bodyLimit({
    maxSize: config.limits.pushBytes,
    onError: () => {
      throw new HttpError(413, "too_large", "Too many changes in one request.");
    },
  }),
  async (c) => {
    const user = c.get("user");
    const spaceId = c.req.param("space");
    const input = await body(c, pushBody);
    for (const ch of input.changes) {
      if (ch.op === "upsert" && !ch.data) throw badRequest(`Change ${ch.t}/${ch.id} has no data.`);
      if (ch.data && JSON.stringify(ch.data).length > MAX_RECORD_BYTES) throw new HttpError(413, "too_large", `A ${ch.t} record is too large to sync.`);
    }

    const result = await tx(async (db) => {
      await membership(user.id, spaceId, "member", db);
      return writeChanges(db, spaceId, user.id, input.changes);
    });

    if (result.changes.length) {
      broadcastSpace(spaceId, { type: "changes", space: spaceId, from: result.from, to: result.to, changes: result.changes, by: user.id, origin: input.conn ?? null });
    }
    return c.json(result);
  },
);

sync.get("/:space/sync/pull", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("space");
  const since = Math.max(0, Number.parseInt(c.req.query("since") ?? "0", 10) || 0);
  const limit = Math.min(config.limits.pullPage, Math.max(1, Number.parseInt(c.req.query("limit") ?? "", 10) || config.limits.pullPage));
  const m = await membership(user.id, spaceId);
  // Read the head first: every change at or below it is committed.
  const head = m.space.seq;
  const rows = await query<{ seq: number; tbl: string; id: string; deleted: boolean; data: Record<string, unknown> }>(
    `SELECT seq, tbl, id, deleted, data FROM kern_record
     WHERE space_id = $1 AND seq > $2 AND seq <= $3 ${since === 0 ? "AND NOT deleted" : ""}
     ORDER BY seq LIMIT $4`,
    [spaceId, since, head, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const changes: OutChange[] = page.map((r) => ({ seq: r.seq, t: r.tbl, id: r.id, op: r.deleted ? "delete" : "upsert", data: r.deleted ? null : r.data }));
  // Superseded rows leave gaps; when the page is the last one the cursor jumps to the head.
  const cursor = hasMore ? page[page.length - 1]!.seq : head;
  return c.json({ changes, cursor, head, hasMore, role: m.role });
});

/** Record counts per table (shown in workspace management). */
sync.get("/:space/sync/stats", async (c) => {
  const user = c.get("user");
  const spaceId = c.req.param("space");
  const m = await membership(user.id, spaceId);
  const rows = await query<{ tbl: string; n: number }>(
    "SELECT tbl, count(*)::int AS n FROM kern_record WHERE space_id = $1 AND NOT deleted GROUP BY tbl",
    [spaceId],
  );
  return c.json({ head: m.space.seq, tables: Object.fromEntries(rows.map((r) => [r.tbl, r.n])) });
});
