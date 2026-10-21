// Calendar feeds: a private ICS address per member and space
// (<LINK_URL>/kern/cal/<token>.ics) that calendar apps subscribe to.
// It's built from the space's synced records on every fetch, so it's always
// current: open tasks with due dates and milestones with target dates.
// Rotating the address stops the old one working; leaving the space does too.

import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { one, query } from "../db.js";
import { body, iso, requireUser, type Env } from "../lib/http.js";
import { calendar, type IcsEvent } from "../lib/ics.js";
import { membership } from "../lib/spaces.js";

export const calendarFeeds = new Hono<Env>();
export const calendarPublic = new Hono();

interface FeedRow {
  token: string;
  space_id: string;
  user_id: string;
  options: { includeMilestones?: boolean; projectIds?: string[] | null };
  created_at: Date;
  last_fetched_at: Date | null;
}

const feedUrl = (token: string) => `${config.linkUrl}/kern/cal/${token}.ics`;

function serialize(r: FeedRow | null) {
  return r ? { url: feedUrl(r.token), options: r.options, createdAt: iso(r.created_at), lastFetchedAt: iso(r.last_fetched_at) } : null;
}

const options = z.object({ includeMilestones: z.boolean().default(true), projectIds: z.array(z.string().max(64)).max(200).nullable().default(null) });

calendarFeeds.use("*", requireUser);

calendarFeeds.get("/:space/calendar-feed", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("space"));
  const row = await one<FeedRow>("SELECT * FROM kern_calendar_feed WHERE space_id = $1 AND user_id = $2", [m.space.id, user.id]);
  return c.json({ feed: serialize(row) });
});

/** Creates the address, or replaces it with a new one (the old one stops working). */
calendarFeeds.post("/:space/calendar-feed", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("space"));
  const opts = await body(c, options.partial().default({}));
  const token = randomBytes(32).toString("base64url");
  const row = await one<FeedRow>(
    `INSERT INTO kern_calendar_feed(token, space_id, user_id, options) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (space_id, user_id) DO UPDATE SET token = EXCLUDED.token, options = EXCLUDED.options, created_at = now(), last_fetched_at = NULL
     RETURNING *`,
    [token, m.space.id, user.id, JSON.stringify(options.parse(opts))],
  );
  return c.json({ feed: serialize(row) });
});

calendarFeeds.delete("/:space/calendar-feed", async (c) => {
  const user = c.get("user");
  const m = await membership(user.id, c.req.param("space"));
  await query("DELETE FROM kern_calendar_feed WHERE space_id = $1 AND user_id = $2", [m.space.id, user.id]);
  return c.json({ ok: true });
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

calendarPublic.get("/kern/cal/:file", async (c) => {
  const token = c.req.param("file").replace(/\.ics$/, "");
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return c.body("Not found", 404);
  const feed = await one<FeedRow & { space_name: string; kind: string }>(
    `SELECT f.*, s.name AS space_name, s.kind FROM kern_calendar_feed f
     JOIN kern_space s ON s.id = f.space_id AND s.deleted_at IS NULL
     JOIN kern_member m ON m.space_id = f.space_id AND m.user_id = f.user_id
     WHERE f.token = $1`,
    [token],
  );
  if (!feed) return c.body("Not found", 404);
  const projects = new Map<string, string>();
  for (const r of await query<{ id: string; name: string; deleted: string | null; archived: string | null }>(
    `SELECT id, data->>'name' AS name, data->>'deleted_at' AS deleted, data->>'archived_at' AS archived FROM kern_record WHERE space_id = $1 AND tbl = 'projects' AND NOT deleted`,
    [feed.space_id],
  )) {
    if (!r.deleted && !r.archived) projects.set(r.id, r.name ?? "Project");
  }
  const only = feed.options.projectIds?.length ? new Set(feed.options.projectIds) : null;
  const inScope = (pid: string | null) => (pid ? projects.has(pid) && (!only || only.has(pid)) : !only);
  const events: IcsEvent[] = [];
  const tasks = await query<{ id: string; d: Record<string, unknown> }>(
    `SELECT id, data AS d FROM kern_record WHERE space_id = $1 AND tbl = 'tasks' AND NOT deleted
       AND data->>'due_date' IS NOT NULL AND data->>'deleted_at' IS NULL AND data->>'archived_at' IS NULL AND data->>'status' IS DISTINCT FROM 'completed'
     LIMIT 5000`,
    [feed.space_id],
  );
  for (const { id, d } of tasks) {
    const pid = typeof d.project_id === "string" ? d.project_id : null;
    if (!inScope(pid)) continue;
    const due = String(d.due_date ?? "");
    const time = typeof d.due_time === "string" && TIME.test(d.due_time) ? d.due_time : null;
    if (!DATE.test(due)) continue;
    events.push({
      uid: `${id}@kern`,
      title: String(d.title ?? "Task"),
      description: typeof d.description === "string" ? d.description : undefined,
      categories: pid ? projects.get(pid) : undefined,
      start: time ? `${due}T${time}` : due,
      minutes: typeof d.estimate_minutes === "number" ? d.estimate_minutes : undefined,
    });
  }
  if (feed.options.includeMilestones !== false) {
    const ms = await query<{ id: string; d: Record<string, unknown> }>(
      `SELECT id, data AS d FROM kern_record WHERE space_id = $1 AND tbl = 'milestones' AND NOT deleted AND data->>'target_date' IS NOT NULL AND data->>'status' NOT IN ('cancelled', 'completed')`,
      [feed.space_id],
    );
    for (const { id, d } of ms) {
      const pid = typeof d.project_id === "string" ? d.project_id : null;
      if (!inScope(pid) || !DATE.test(String(d.target_date))) continue;
      events.push({ uid: `${id}@kern`, title: `◆ ${String(d.title ?? "Milestone")}`, description: pid ? `Milestone in ${projects.get(pid)}` : undefined, categories: pid ? projects.get(pid) : undefined, start: String(d.target_date) });
    }
  }
  await query("UPDATE kern_calendar_feed SET last_fetched_at = now() WHERE token = $1", [token]);
  const name = feed.kind === "personal" ? "Kern" : `Kern · ${feed.space_name}`;
  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "private, max-age=300");
  c.header("Content-Disposition", 'inline; filename="kern.ics"');
  return c.body(calendar(name, events));
});
