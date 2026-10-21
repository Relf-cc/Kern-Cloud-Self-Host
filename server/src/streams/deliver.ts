// Turning an accepted submission into records. A delivery renders the title
// and body, opens the GitHub issue (when the stream does that), then commits
// the task, its labels, the issue link or the inbox item to the space in one
// transaction - through the same sequence-numbered path as sync pushes, so
// every member's app receives them like any other change. Each delivery is
// logged, and members are notified.

import { config } from "../config.js";
import { one, query, tx, type Db } from "../db.js";
import { send, streamMail } from "../mail.js";
import { broadcastSpace } from "../realtime.js";
import { writeChanges, type InChange } from "../routes/sync.js";
import { createIssue, GithubError, type CreatedIssue } from "./github.js";
import { dateIn, escapeMarkdown, getPath, neutralizeMentions, oneLine, render, uuidv7, type Payload, type TemplateContext } from "./kit.js";
import type { StreamConfig } from "./schema.js";
import { unseal, type StreamRow } from "./store.js";

export interface SubmissionMeta {
  receivedAt: Date;
  origin: string | null;
  referer: string | null;
  userAgent: string | null;
  sender: string | null;
  auth: string;
  contentType: string | null;
}

export interface Submission {
  payload: Payload;
  meta: SubmissionMeta;
  payloadHash: string | null;
  idempotencyKey: string | null;
  test: boolean;
}

export type DeliveryStatus = "delivered" | "partial" | "failed";

export interface Outcome {
  eventId: number;
  status: DeliveryStatus;
  code: string | null;
  message: string | null;
  title: string;
  taskId: string | null;
  inboxId: string | null;
  issue: { number: number; url: string } | null;
  notes: string[];
}

interface SpaceInfo {
  id: string;
  name: string;
  timezone: string | null;
  deleted_at: Date | null;
}

const TITLE_MAX = 200;
const BODY_MAX = 60_000;

async function record(db: Db | undefined, spaceId: string, tbl: string, id: string): Promise<Record<string, unknown> | null> {
  const r = await one<{ data: Record<string, unknown> }>("SELECT data FROM kern_record WHERE space_id = $1 AND tbl = $2 AND id = $3 AND NOT deleted", [spaceId, tbl, id], db);
  return r?.data ?? null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

// ------------------------------------------------------------ rendering

export interface Rendered {
  title: string;
  /** For Kern (task description, inbox item). */
  body: string;
  /** For GitHub: mentions neutralised when the stream asks for it. */
  githubBody: string;
}

export function renderSubmission(stream: Pick<StreamRow, "id" | "name">, cfg: StreamConfig, sub: Pick<Submission, "payload" | "meta" | "test">): Rendered {
  const ctx: TemplateContext = {
    payload: sub.payload,
    fields: cfg.fields.list,
    stream: { id: stream.id, name: stream.name },
    meta: {
      receivedAt: sub.meta.receivedAt.toISOString(),
      origin: sub.meta.origin,
      referer: sub.meta.referer,
      userAgent: sub.meta.userAgent,
      sender: sub.meta.sender,
    },
  };
  const plain = (s: string) => s;
  const kernEscape = cfg.security.escapeMarkdown ? escapeMarkdown : plain;
  const ghEscape = (s: string) => {
    const x = kernEscape(s);
    return cfg.github.neutralizeMentions ? neutralizeMentions(x) : x;
  };

  let title = oneLine(render(cfg.templates.title, ctx, { escape: plain }));
  if (!title) title = oneLine(render(cfg.templates.titleFallback, ctx, { escape: plain }));
  if (!title) title = `New submission via ${stream.name}`;
  if (title.length > TITLE_MAX) title = `${title.slice(0, TITLE_MAX - 1)}…`;

  const bodyWith = (escape: (s: string) => string) => {
    const parts = [render(cfg.templates.body, ctx, { escape }).trim()];
    if (cfg.templates.includeJson) parts.push(render("{{_json}}", ctx, { escape }));
    if (cfg.templates.footer) {
      const when = sub.meta.receivedAt.toISOString().replace("T", " ").slice(0, 16);
      const where = sub.meta.referer ?? sub.meta.origin;
      parts.push(`---\n_Received via the ${escapeMarkdown(stream.name)} stream on ${when} UTC${where ? ` from ${escape(where)}` : ""}${sub.test ? " (test)" : ""}._`);
    }
    const out = parts.filter(Boolean).join("\n\n");
    return out.length > BODY_MAX ? `${out.slice(0, BODY_MAX)}\n\n…(cut short)` : out;
  };
  return { title, body: bodyWith(kernEscape), githubBody: bodyWith(ghEscape) };
}

// ------------------------------------------------------------ targets

interface Target {
  projectId: string | null;
  columnId: string | null;
  status: string;
  labelIds: string[];
  /** owner/name of the project's connected repository, as the app writes it. */
  projectRepo: string | null;
  notes: string[];
}

/** Where a task goes, checked against what currently exists in the space. */
async function resolveTarget(db: Db, spaceId: string, cfg: StreamConfig): Promise<Target> {
  const notes: string[] = [];
  let projectId: string | null = null;
  let columnId: string | null = null;
  let status: string = cfg.task.status;

  if (cfg.task.columnId) {
    const col = await record(db, spaceId, "board_columns", cfg.task.columnId);
    const board = col && str(col.board_id) ? await record(db, spaceId, "boards", str(col.board_id)!) : null;
    const project = board && str(board.project_id) ? await record(db, spaceId, "projects", str(board.project_id)!) : null;
    if (col && board && project && !project.deleted_at) {
      columnId = cfg.task.columnId;
      projectId = str(board.project_id);
      if (str(col.status)) status = str(col.status)!;
    } else {
      notes.push("The chosen board column no longer exists, so the task went to the project instead.");
    }
  }
  if (!projectId && cfg.task.projectId) {
    const project = await record(db, spaceId, "projects", cfg.task.projectId);
    if (project && !project.deleted_at) projectId = cfg.task.projectId;
    else notes.push("The chosen project no longer exists, so the task went to the Inbox.");
  }
  if (projectId && status === "inbox") status = "todo";

  const labelIds = cfg.task.labelIds.length
    ? (
        await query<{ id: string }>("SELECT id FROM kern_record WHERE space_id = $1 AND tbl = 'labels' AND id = ANY($2::text[]) AND NOT deleted", [spaceId, cfg.task.labelIds], db)
      ).map((r) => r.id)
    : [];
  if (labelIds.length < cfg.task.labelIds.length) notes.push("Some of the stream's labels no longer exist and were skipped.");

  let projectRepo: string | null = null;
  if (projectId) {
    const repo = await record(db, spaceId, "project_repos", projectId);
    if (repo && str(repo.owner) && str(repo.name)) projectRepo = `${str(repo.owner)}/${str(repo.name)}`;
  }
  return { projectId, columnId, status, labelIds, projectRepo, notes };
}

function priorityFor(cfg: StreamConfig, payload: Payload): number {
  if (cfg.task.priorityField) {
    const v = getPath(payload, cfg.task.priorityField);
    if (v !== undefined && v !== null) {
      const key = String(v).trim().toLowerCase();
      for (const [k, p] of Object.entries(cfg.task.priorityMap)) if (k.trim().toLowerCase() === key) return p;
      const n = Number(key);
      if (Number.isInteger(n) && n >= 0 && n <= 4) return n;
    }
  }
  return cfg.task.priority;
}

const numeric = (col: string) => `CASE WHEN jsonb_typeof(data->'${col}') = 'number' THEN (data->>'${col}')::float8 END`;

// ------------------------------------------------------------ notifications

const lastEmail = new Map<string, number>();

async function recipients(stream: StreamRow, cfg: StreamConfig): Promise<string[]> {
  if (cfg.notify.emailTo === "admins") {
    const rows = await query<{ email: string }>(
      `SELECT u.email FROM kern_member m JOIN "user" u ON u.id = m.user_id
       WHERE m.space_id = $1 AND m.role IN ('owner', 'admin') AND u."emailVerified" = true`,
      [stream.space_id],
    );
    return rows.map((r) => r.email);
  }
  const r = await one<{ email: string }>(
    `SELECT u.email FROM "user" u WHERE u.id = coalesce($1, (SELECT owner_id FROM kern_space WHERE id = $2)) AND u."emailVerified" = true`,
    [stream.created_by, stream.space_id],
  );
  return r ? [r.email] : [];
}

function notify(stream: StreamRow, cfg: StreamConfig, space: SpaceInfo, out: Outcome, preview: string, test: boolean) {
  if (cfg.notify.app) {
    broadcastSpace(stream.space_id, {
      type: "stream",
      event: "delivery",
      space: stream.space_id,
      stream: { id: stream.id, name: stream.name },
      status: out.status,
      title: out.title,
      taskId: out.taskId,
      inboxId: out.inboxId,
      issueUrl: out.issue?.url ?? null,
      test,
    });
  }
  const wants = cfg.notify.email === "each" || (cfg.notify.email === "failures" && out.status !== "delivered");
  if (!wants) return;
  // At most one email a minute per stream; the delivery log has everything.
  const now = Date.now();
  if ((lastEmail.get(stream.id) ?? 0) > now - 60_000) return;
  lastEmail.set(stream.id, now);
  void recipients(stream, cfg)
    .then((list) =>
      Promise.all(
        list.map((to) =>
          send(streamMail({ to, stream: stream.name, space: space.name, status: out.status, title: out.title, preview, issueUrl: out.issue?.url ?? null, problem: out.status === "delivered" ? null : out.message })),
        ),
      ),
    )
    .catch((e) => console.error("[streams] notification email failed", e));
}

// ------------------------------------------------------------ delivery

async function logEvent(stream: StreamRow, cfg: StreamConfig, sub: Submission, o: Omit<Outcome, "eventId" | "title" | "notes">, started: number): Promise<number> {
  const values = [
    stream.id,
    sub.meta.receivedAt,
    o.status,
    o.code,
    o.message,
    sub.test,
    sub.meta.auth,
    sub.meta.sender,
    sub.meta.origin,
    sub.meta.userAgent?.slice(0, 300) ?? null,
    sub.meta.contentType,
    cfg.log.storePayloads ? JSON.stringify(sub.payload) : null,
    sub.payloadHash,
    o.status === "failed" ? null : sub.idempotencyKey,
    o.taskId,
    o.inboxId,
    o.issue?.number ?? null,
    o.issue?.url ?? null,
    Date.now() - started,
  ];
  const sql = `INSERT INTO kern_stream_event(stream_id, received_at, status, code, message, test, auth, ip_hash, origin, user_agent, content_type,
       payload, payload_hash, idempotency_key, task_id, inbox_id, issue_number, issue_url, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19) RETURNING id`;
  let row: { id: number } | null;
  try {
    row = await one<{ id: number }>(sql, values);
  } catch (e) {
    // Two requests raced with the same idempotency key: keep both entries.
    if ((e as { code?: string }).code !== "23505") throw e;
    values[13] = null;
    row = await one<{ id: number }>(sql, values);
  }
  await query("UPDATE kern_stream SET last_delivery_at = now(), delivery_count = delivery_count + 1 WHERE id = $1", [stream.id]);
  return row!.id;
}

/** Logs a submission that was refused before delivery (bad fields, spam, duplicates…). */
export async function logRejection(stream: StreamRow, cfg: StreamConfig, sub: Submission, status: "rejected" | "spam" | "duplicate", code: string, message: string, started: number, extra: { taskId?: string | null; issue?: { number: number; url: string } | null } = {}) {
  const r = await one<{ id: number }>(
    `INSERT INTO kern_stream_event(stream_id, received_at, status, code, message, test, auth, ip_hash, origin, user_agent, content_type, payload, payload_hash, task_id, issue_number, issue_url, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17) RETURNING id`,
    [
      stream.id,
      sub.meta.receivedAt,
      status,
      code,
      message,
      sub.test,
      sub.meta.auth,
      sub.meta.sender,
      sub.meta.origin,
      sub.meta.userAgent?.slice(0, 300) ?? null,
      sub.meta.contentType,
      cfg.log.storePayloads && status !== "spam" ? JSON.stringify(sub.payload) : null,
      sub.payloadHash,
      extra.taskId ?? null,
      extra.issue?.number ?? null,
      extra.issue?.url ?? null,
      Date.now() - started,
    ],
  );
  return r!.id;
}

/** Delivers a validated submission. Never throws for delivery problems; they're in the outcome. */
export async function deliver(stream: StreamRow, cfg: StreamConfig, sub: Submission): Promise<Outcome> {
  const started = Date.now();
  const notes: string[] = [];
  const space = await one<SpaceInfo>("SELECT id, name, timezone, deleted_at FROM kern_space WHERE id = $1", [stream.space_id]);
  const rendered = renderSubmission(stream, cfg, sub);
  const finish = async (o: Omit<Outcome, "eventId" | "title" | "notes">): Promise<Outcome> => {
    const eventId = await logEvent(stream, cfg, sub, o, started);
    const out: Outcome = { ...o, eventId, title: rendered.title, notes };
    if (space && !space.deleted_at) notify(stream, cfg, space, out, rendered.body, sub.test);
    return out;
  };
  if (!space || space.deleted_at) {
    return finish({ status: "failed", code: "space_deleted", message: "The workspace this stream belongs to was deleted.", taskId: null, inboxId: null, issue: null });
  }

  const wantTask = cfg.action === "task" || cfg.action === "task_issue";
  const wantIssue = cfg.action === "issue" || cfg.action === "task_issue";

  // 1. The GitHub issue (first, so a linked task can start in step with it).
  let issue: CreatedIssue | null = null;
  let issueProblem: { code: string; message: string } | null = null;
  if (wantIssue) {
    if (!cfg.github.repo) issueProblem = { code: "github_not_configured", message: "Choose a GitHub repository in the stream's GitHub settings." };
    else if (!stream.github_token_enc) issueProblem = { code: "github_not_configured", message: "Add a GitHub token in the stream's GitHub settings." };
    else {
      try {
        const token = unseal(stream.id, "github", stream.github_token_enc);
        issue = await createIssue(token, cfg.github.repo, { title: rendered.title, body: rendered.githubBody, labels: cfg.github.labels, assignees: cfg.github.assignees });
        notes.push(...issue.notes);
      } catch (e) {
        issueProblem = { code: "github_failed", message: e instanceof GithubError ? e.message : "The GitHub token couldn't be read. Add it again." };
        if (!(e instanceof GithubError)) console.error("[streams] github token unreadable", e);
      }
    }
  }

  if (cfg.action === "issue") {
    return issue
      ? finish({ status: "delivered", code: null, message: notes.join(" ") || null, taskId: null, inboxId: null, issue: { number: issue.number, url: issue.url } })
      : finish({ status: "failed", code: issueProblem!.code, message: issueProblem!.message, taskId: null, inboxId: null, issue: null });
  }

  // 2. The Kern records, in one transaction.
  const now = Date.now();
  const actor = `stream:${stream.id.slice(0, 12)}`;
  let taskId: string | null = null;
  let inboxId: string | null = null;
  let linked = false;
  try {
    const result = await tx(async (db) => {
      // Lock first so concurrent deliveries get distinct positions.
      await query("SELECT 1 FROM kern_space WHERE id = $1 FOR UPDATE", [stream.space_id], db);
      const changes: InChange[] = [];
      if (wantTask) {
        const t = await resolveTarget(db, stream.space_id, cfg);
        notes.push(...t.notes);
        taskId = uuidv7(now);
        const sort = await one<{ m: number | null }>(
          `SELECT max(${numeric("sort_order")}) AS m FROM kern_record WHERE space_id = $1 AND tbl = 'tasks' AND NOT deleted
             AND (data->>'parent_id') IS NULL AND (data->>'project_id') IS NOT DISTINCT FROM $2`,
          [stream.space_id, t.projectId],
          db,
        );
        const boardOrder = t.columnId
          ? await one<{ m: number | null }>(`SELECT max(${numeric("board_order")}) AS m FROM kern_record WHERE space_id = $1 AND tbl = 'tasks' AND NOT deleted AND data->>'column_id' = $2`, [stream.space_id, t.columnId], db)
          : null;
        linked = !!issue && cfg.github.linkToTask && !!t.projectId && !!t.projectRepo && t.projectRepo.toLowerCase() === cfg.github.repo!.toLowerCase();
        let description = linked ? issue!.body : rendered.body;
        if (issue && !linked) description += `\n\nGitHub issue: ${issue.url}`;
        changes.push({
          t: "tasks",
          id: taskId,
          op: "upsert",
          full: true,
          data: {
            id: taskId,
            title: linked ? issue!.title : rendered.title,
            description,
            status: t.status,
            priority: priorityFor(cfg, sub.payload),
            project_id: t.projectId,
            column_id: t.columnId,
            parent_id: null,
            due_date: cfg.task.dueInDays === null ? null : dateIn(cfg.task.dueInDays, space.timezone, sub.meta.receivedAt),
            due_time: null,
            start_date: null,
            estimate_minutes: null,
            tracked_seconds: 0,
            sort_order: (sort?.m ?? 0) + 1,
            board_order: t.columnId ? (boardOrder?.m ?? 0) + 1 : 0,
            recurrence: null,
            series_id: null,
            reminder_minutes: null,
            completed_at: null,
            archived_at: null,
            deleted_at: null,
            milestone_id: null,
            created_at: now,
            updated_at: now,
          },
        });
        for (const labelId of t.labelIds) {
          changes.push({ t: "task_labels", id: `${taskId}|${labelId}`, op: "upsert", full: true, data: { task_id: taskId, label_id: labelId } });
        }
        if (linked) {
          // The repository name exactly as the app stores it, so its issue
          // sync recognises the link (and doesn't import a duplicate task).
          const repo = t.projectRepo!;
          changes.push({
            t: "task_issue_links",
            id: `${repo}|${issue!.number}`,
            op: "upsert",
            full: true,
            data: {
              repo,
              issue_number: issue!.number,
              task_id: taskId,
              project_id: t.projectId,
              html_url: issue!.url,
              remote_updated_at: issue!.updatedAt,
              synced_at: now,
              synced_title: issue!.title,
              synced_body: issue!.body,
              synced_state: "open",
              synced_labels: JSON.stringify(issue!.labels),
            },
          });
        }
      } else {
        inboxId = uuidv7(now);
        changes.push({ t: "inbox_items", id: inboxId, op: "upsert", full: true, data: { id: inboxId, kind: "idea", content: `${rendered.title}\n\n${rendered.body}`.trim(), created_at: now } });
      }
      return writeChanges(db, stream.space_id, actor, changes);
    });
    if (result.changes.length) {
      broadcastSpace(stream.space_id, { type: "changes", space: stream.space_id, from: result.from, to: result.to, changes: result.changes, by: actor, origin: null });
    }
  } catch (e) {
    console.error("[streams] delivery failed", e);
    const problem = issue ? `The GitHub issue was opened (${issue.url}) but the task couldn't be saved.` : "The submission couldn't be saved. Try redelivering it.";
    return finish({ status: issue ? "partial" : "failed", code: "save_failed", message: problem, taskId: null, inboxId: null, issue: issue ? { number: issue.number, url: issue.url } : null });
  }

  if (wantIssue && !issue) {
    return finish({ status: "partial", code: issueProblem!.code, message: `The task was created, but no GitHub issue: ${issueProblem!.message}`, taskId, inboxId, issue: null });
  }
  if (issue && !linked && cfg.github.linkToTask) notes.push("The issue isn't linked to the task because the task's project isn't connected to that repository.");
  return finish({ status: "delivered", code: null, message: notes.join(" ") || null, taskId, inboxId, issue: issue ? { number: issue.number, url: issue.url } : null });
}

/** Removes delivery log entries past each stream's retention (and the global maximum). */
export async function pruneEvents(): Promise<number> {
  const rows = await query<{ id: number }>(
    `DELETE FROM kern_stream_event e USING kern_stream s
     WHERE s.id = e.stream_id
       AND e.received_at < now() - make_interval(days => LEAST($1::int, coalesce((s.config->'log'->>'retentionDays')::int, 30)))
     RETURNING e.id`,
    [config.limits.streamLogDays],
  );
  return rows.length;
}
