// Diagnostics, and the repairs that go with them.
//
// `kernctl heal` and Kern Platform's Health page both run this. Every check
// answers three things: is it right, what would make it right, and can the
// server do that itself. A check with a `fix` is safe to run at any time and
// safe to run twice - it removes expired rows, reclaims space or restores a
// row that should always exist. Nothing here deletes anybody's work: the
// destructive paths (purging a space, deleting an account) are explicit
// endpoints an administrator has to ask for by name.
//
// Checks are cheap enough to run on every page load of the Health view. Two
// of them (vacuum, mail) do real work and are only ever run as a fix.

import { createConnection } from "node:net";
import nodemailer from "nodemailer";
import { config } from "../config.js";
import { one, pool, query } from "../db.js";
import { collectUnusedAssets } from "../routes/assets.js";
import { pruneEvents } from "../streams/deliver.js";

export type Status = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  /** "config" | "database" | "storage" | "security" | "mail" */
  group: string;
  title: string;
  status: Status;
  /** One sentence an administrator can act on. */
  detail: string;
  /** What running the fix would do, when there is one. */
  fix?: string;
  /** Numbers worth showing next to the check. */
  facts?: Record<string, string | number>;
}

type Runner = {
  id: string;
  group: string;
  title: string;
  run: () => Promise<Omit<Check, "id" | "group" | "title" | "fix">>;
  /** Present when the server can repair this itself. Returns what it did. */
  fix?: { describe: string; run: () => Promise<string> };
};

const count = async (sql: string, params: unknown[] = []): Promise<number> => {
  const row = await one<{ n: string }>(sql, params);
  return Number(row?.n ?? 0);
};

const bytes = (n: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

/** Can we open a TCP connection to the SMTP host? Used by the mail check. */
function probe(host: string, port: number, ms = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const RUNNERS: Runner[] = [
  {
    id: "database",
    group: "database",
    title: "Database reachable",
    run: async () => {
      const started = Date.now();
      const row = await one<{ v: string; size: string }>("SELECT version() AS v, pg_database_size(current_database())::text AS size");
      const ms = Date.now() - started;
      const version = (row?.v ?? "").split(" ").slice(0, 2).join(" ");
      return {
        status: ms > 500 ? "warn" : "ok",
        detail: ms > 500 ? `${version} answered, but took ${ms} ms - the database is under load or far away.` : `${version}, answering in ${ms} ms.`,
        facts: { version, roundTripMs: ms, size: bytes(Number(row?.size ?? 0)) },
      };
    },
  },
  {
    id: "migrations",
    group: "database",
    title: "Schema up to date",
    run: async () => {
      const applied = await count("SELECT coalesce(max(version), 0) AS n FROM kern_migration");
      const expected = await count("SELECT count(*) AS n FROM kern_migration");
      return {
        status: applied > 0 ? "ok" : "fail",
        detail: applied > 0 ? `${applied} migration step${applied === 1 ? "" : "s"} applied.` : "No migrations have run. Restart the server; it migrates on start.",
        facts: { applied, recorded: expected },
      };
    },
  },
  {
    id: "connection-pool",
    group: "database",
    title: "Connection pool",
    run: async () => {
      const waiting = pool.waitingCount;
      return {
        status: waiting > 0 ? "warn" : "ok",
        detail: waiting > 0 ? `${waiting} quer${waiting === 1 ? "y is" : "ies are"} waiting for a connection. Raise the pool size or look for slow queries.` : "No queries are waiting for a connection.",
        facts: { total: pool.totalCount, idle: pool.idleCount, waiting },
      };
    },
  },
  {
    id: "auth-secret",
    group: "security",
    title: "Session secret strong enough",
    run: async () => {
      const length = config.authSecret.length;
      if (length < 32) {
        return { status: "fail", detail: `BETTER_AUTH_SECRET is only ${length} characters. Generate one with "openssl rand -base64 48" and restart - everyone will have to sign in again.` };
      }
      const weak = /^(change-?me|secret|password|test|dev)/i.test(config.authSecret);
      return {
        status: weak ? "fail" : "ok",
        detail: weak ? "BETTER_AUTH_SECRET looks like a placeholder. Replace it with random bytes." : `${length} characters of session secret.`,
      };
    },
  },
  {
    id: "streams-key",
    group: "security",
    title: "Stream encryption key set",
    run: async () => {
      const streams = await count("SELECT count(*) AS n FROM kern_stream");
      if (config.streamsKey) return { status: "ok", detail: "Stream secrets are encrypted with their own key." };
      if (!streams) return { status: "skip", detail: "No streams exist yet. Set STREAMS_ENCRYPTION_KEY before creating one." };
      return {
        status: "warn",
        detail: `STREAMS_ENCRYPTION_KEY isn't set, so the key for ${streams} stream${streams === 1 ? "" : "s"} is derived from BETTER_AUTH_SECRET. Rotating that secret would make their stored credentials unreadable.`,
        facts: { streams },
      };
    },
  },
  {
    id: "public-url",
    group: "config",
    title: "Public address usable",
    run: async () => {
      const url = config.publicUrl;
      const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(url);
      if (local) {
        return {
          status: "warn",
          detail: `PUBLIC_URL is ${url}. That is fine on one machine, but invite links and stream endpoints handed to anybody else won't resolve. Set it to the address people actually use.`,
          facts: { publicUrl: url },
        };
      }
      if (url.startsWith("http://")) {
        return { status: "warn", detail: `PUBLIC_URL is plain HTTP (${url}). Session tokens and sync traffic would cross the network unencrypted; put the server behind TLS.`, facts: { publicUrl: url } };
      }
      return { status: "ok", detail: `Serving ${url} over HTTPS.`, facts: { publicUrl: url } };
    },
  },
  {
    id: "admin-exposure",
    group: "security",
    title: "Management API reach",
    run: async () => {
      if (config.admin.localOnly) return { status: "ok", detail: "The management API answers only this machine (loopback)." };
      if (!config.admin.allowFrom.length) {
        return { status: "fail", detail: "ADMIN_LOCAL_ONLY is off and ADMIN_ALLOW_FROM is empty, so nothing can reach the management API. Add an address, or turn loopback-only back on." };
      }
      const broad = config.admin.allowFrom.filter((r) => /\/(?:[0-9]|1[0-5])$/.test(r) || r === "0.0.0.0/0");
      return {
        status: broad.length ? "warn" : "ok",
        detail: broad.length
          ? `ADMIN_ALLOW_FROM includes a very wide range (${broad.join(", ")}). Narrow it to the machines that actually manage this instance.`
          : `Reachable from ${config.admin.allowFrom.join(", ")}.`,
        facts: { allowFrom: config.admin.allowFrom.join(", ") },
      };
    },
  },
  {
    id: "admin-tokens",
    group: "security",
    title: "Management tokens",
    run: async () => {
      const active = await count("SELECT count(*) AS n FROM kern_admin_token WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
      const stale = await count("SELECT count(*) AS n FROM kern_admin_token WHERE revoked_at IS NULL AND last_used_at IS NULL AND created_at < now() - interval '30 days'");
      return {
        status: stale > 0 ? "warn" : "ok",
        detail: stale > 0 ? `${stale} token${stale === 1 ? " has" : "s have"} never been used in over a month. Revoke what you aren't using.` : `${active} token${active === 1 ? "" : "s"} in use.`,
        facts: { active, neverUsed: stale },
      };
    },
    fix: {
      describe: "Revoke tokens created over 30 days ago that have never been used.",
      run: async () => {
        const rows = await query("UPDATE kern_admin_token SET revoked_at = now() WHERE revoked_at IS NULL AND last_used_at IS NULL AND created_at < now() - interval '30 days' RETURNING id");
        return `Revoked ${rows.length} unused token${rows.length === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "mail",
    group: "mail",
    title: "Outgoing email",
    run: async () => {
      if (config.mailToConsole) {
        return {
          status: "warn",
          detail: "SMTP_HOST isn't set, so verification codes and invitations are printed to the server log instead of sent. Nobody can finish signing up without reading the log.",
        };
      }
      const reachable = await probe(config.mail.host, config.mail.port);
      return {
        status: reachable ? "ok" : "fail",
        detail: reachable ? `${config.mail.host}:${config.mail.port} accepts connections.` : `Can't open a connection to ${config.mail.host}:${config.mail.port}. Codes and invitations will not be delivered.`,
        facts: { host: config.mail.host, port: config.mail.port, from: config.mail.from },
      };
    },
    fix: {
      describe: "Try a full SMTP handshake and sign-in, the way sending an email would.",
      run: async () => {
        if (config.mailToConsole) return "SMTP isn't configured; nothing to verify.";
        const transport = nodemailer.createTransport({
          host: config.mail.host,
          port: config.mail.port,
          secure: config.mail.secure,
          auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
        });
        try {
          await transport.verify();
          return `${config.mail.host} accepted the handshake${config.mail.user ? " and the credentials" : ""}.`;
        } finally {
          transport.close();
        }
      },
    },
  },
  {
    id: "expired-sessions",
    group: "database",
    title: "Expired sessions cleared",
    run: async () => {
      const n = await count(`SELECT count(*) AS n FROM "session" WHERE "expiresAt" < now()`);
      return {
        status: n > 500 ? "warn" : "ok",
        detail: n ? `${n} expired session row${n === 1 ? "" : "s"} left behind. They can't be used to sign in, but they take up space.` : "No expired sessions.",
        facts: { expired: n },
      };
    },
    fix: {
      describe: "Delete session rows that have already expired.",
      run: async () => {
        const rows = await query(`DELETE FROM "session" WHERE "expiresAt" < now() RETURNING id`);
        return `Removed ${rows.length} expired session${rows.length === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "expired-verifications",
    group: "database",
    title: "Expired codes cleared",
    run: async () => {
      const n = await count(`SELECT count(*) AS n FROM "verification" WHERE "expiresAt" < now() - interval '1 day'`);
      return { status: n > 1000 ? "warn" : "ok", detail: n ? `${n} one-time code${n === 1 ? "" : "s"} expired over a day ago.` : "No stale one-time codes.", facts: { expired: n } };
    },
    fix: {
      describe: "Delete one-time codes that expired more than a day ago.",
      run: async () => {
        const rows = await query(`DELETE FROM "verification" WHERE "expiresAt" < now() - interval '1 day' RETURNING id`);
        return `Removed ${rows.length} stale code${rows.length === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "stale-invites",
    group: "database",
    title: "Invitations tidy",
    run: async () => {
      const n = await count("SELECT count(*) AS n FROM kern_invite WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at < now()");
      return {
        status: "ok",
        detail: n ? `${n} invitation${n === 1 ? "" : "s"} expired without being accepted. They are already refused on use; clearing them frees the address to be invited again.` : "No expired invitations.",
        facts: { expired: n },
      };
    },
    fix: {
      describe: "Mark invitations that expired over 30 days ago as revoked, freeing those addresses to be invited again.",
      run: async () => {
        const rows = await query(
          `UPDATE kern_invite SET revoked_at = now()
           WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at < now() - interval '30 days' RETURNING id`,
        );
        return `Closed ${rows.length} long-expired invitation${rows.length === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "unused-assets",
    group: "storage",
    title: "Whiteboard images referenced",
    run: async () => {
      const row = await one<{ n: string; size: string }>("SELECT count(*) AS n, coalesce(sum(size), 0)::text AS size FROM kern_asset");
      const total = Number(row?.size ?? 0);
      return {
        status: "ok",
        detail: `${Number(row?.n ?? 0)} shared image${Number(row?.n ?? 0) === 1 ? "" : "s"} using ${bytes(total)}. Images nothing refers to are swept hourly.`,
        facts: { images: Number(row?.n ?? 0), stored: bytes(total) },
      };
    },
    fix: {
      describe: "Sweep whiteboard images that no record refers to any more.",
      run: async () => {
        const n = await collectUnusedAssets();
        return `Removed ${n} unreferenced image${n === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "stream-log",
    group: "storage",
    title: "Stream delivery log within retention",
    run: async () => {
      const over = await count(`SELECT count(*) AS n FROM kern_stream_event WHERE received_at < now() - ($1 || ' days')::interval`, [config.limits.streamLogDays]);
      const total = await count("SELECT count(*) AS n FROM kern_stream_event");
      return {
        status: over > 10_000 ? "warn" : "ok",
        detail: over ? `${over} delivery log entr${over === 1 ? "y is" : "ies are"} past the ${config.limits.streamLogDays}-day cap. They are pruned hourly.` : `${total} delivery log entr${total === 1 ? "y" : "ies"}, all within retention.`,
        facts: { entries: total, overRetention: over },
      };
    },
    fix: {
      describe: "Prune delivery log entries past their retention.",
      run: async () => {
        const n = await pruneEvents();
        return `Pruned ${n} log entr${n === 1 ? "y" : "ies"}.`;
      },
    },
  },
  {
    id: "deleted-spaces",
    group: "storage",
    title: "Deleted workspaces purged",
    run: async () => {
      const row = await one<{ n: string; oldest: Date | null }>("SELECT count(*) AS n, min(deleted_at) AS oldest FROM kern_space WHERE deleted_at IS NOT NULL");
      const n = Number(row?.n ?? 0);
      return {
        status: "ok",
        detail: n ? `${n} workspace${n === 1 ? "" : "s"} marked deleted and still holding records. Purging frees the space for good.` : "No deleted workspaces are still holding data.",
        facts: { deleted: n, oldest: row?.oldest ? row.oldest.toISOString() : "-" },
      };
    },
    fix: {
      describe: "Permanently remove workspaces deleted over 30 days ago, with their records, images and streams.",
      run: async () => {
        const rows = await query<{ id: string; name: string }>("DELETE FROM kern_space WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days' RETURNING id, name");
        return rows.length ? `Purged ${rows.length} workspace${rows.length === 1 ? "" : "s"}: ${rows.map((r) => r.name).join(", ")}.` : "Nothing was old enough to purge.";
      },
    },
  },
  {
    id: "owner-membership",
    group: "database",
    title: "Every space has its owner",
    run: async () => {
      const n = await count(
        `SELECT count(*) AS n FROM kern_space s
         WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM kern_member m WHERE m.space_id = s.id AND m.user_id = s.owner_id AND m.role = 'owner')`,
      );
      return {
        status: n ? "fail" : "ok",
        detail: n ? `${n} space${n === 1 ? "" : "s"} have no owner membership row, so the owner can't open them.` : "Every live space has an owner membership row.",
        facts: { missing: n },
      };
    },
    fix: {
      describe: "Restore the owner's membership row on any space missing one.",
      run: async () => {
        const rows = await query<{ space_id: string }>(
          `INSERT INTO kern_member(space_id, user_id, role)
           SELECT s.id, s.owner_id, 'owner' FROM kern_space s
           WHERE s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM kern_member m WHERE m.space_id = s.id AND m.user_id = s.owner_id)
           ON CONFLICT (space_id, user_id) DO UPDATE SET role = 'owner'
           RETURNING space_id`,
        );
        return `Restored ${rows.length} owner membership row${rows.length === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "record-sequence",
    group: "database",
    title: "Change sequences consistent",
    run: async () => {
      // A record newer than its space's head would never be pulled by a client.
      const n = await count(
        `SELECT count(*) AS n FROM kern_space s WHERE s.deleted_at IS NULL
           AND coalesce((SELECT max(r.seq) FROM kern_record r WHERE r.space_id = s.id), 0) > s.seq`,
      );
      return {
        status: n ? "fail" : "ok",
        detail: n ? `${n} space${n === 1 ? "" : "s"} hold records numbered past the space's head, so clients would never pull them.` : "Every space's head is at or past its newest record.",
        facts: { behind: n },
      };
    },
    fix: {
      describe: "Move each space's head up to its newest record, so clients pull the changes they are missing.",
      run: async () => {
        const rows = await query<{ id: string }>(
          `UPDATE kern_space s SET seq = sub.max_seq, updated_at = now()
           FROM (SELECT space_id, max(seq) AS max_seq FROM kern_record GROUP BY space_id) sub
           WHERE s.id = sub.space_id AND sub.max_seq > s.seq RETURNING s.id`,
        );
        return `Corrected ${rows.length} space head${rows.length === 1 ? "" : "s"}.`;
      },
    },
  },
  {
    id: "orphan-records",
    group: "storage",
    title: "Tombstones within reason",
    run: async () => {
      const tombstones = await count("SELECT count(*) AS n FROM kern_record WHERE deleted = true");
      const total = await count("SELECT count(*) AS n FROM kern_record");
      const share = total ? Math.round((tombstones / total) * 100) : 0;
      return {
        status: share > 60 && tombstones > 5000 ? "warn" : "ok",
        detail: `${tombstones} of ${total} records are tombstones (${share}%). They tell other computers about deletions and shouldn't be removed while any device is still catching up.`,
        facts: { tombstones, records: total, percent: share },
      };
    },
  },
  {
    id: "table-sizes",
    group: "storage",
    title: "Largest tables",
    run: async () => {
      const rows = await query<{ name: string; size: string }>(
        `SELECT relname AS name, pg_total_relation_size(c.oid)::text AS size
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind = 'r'
         ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5`,
      );
      const facts: Record<string, string> = {};
      for (const r of rows) facts[r.name] = bytes(Number(r.size));
      return { status: "ok", detail: rows.length ? `Biggest table: ${rows[0]!.name} at ${bytes(Number(rows[0]!.size))}.` : "No tables yet.", facts };
    },
    fix: {
      describe: "Reclaim space and refresh query plans (VACUUM ANALYZE). Safe while the server is running.",
      run: async () => {
        // VACUUM can't run inside a transaction, which is why it goes straight
        // to the pool rather than through tx().
        await pool.query("VACUUM (ANALYZE)");
        return "Vacuumed and analysed the database.";
      },
    },
  },
];

export async function runChecks(): Promise<Check[]> {
  const out: Check[] = [];
  for (const runner of RUNNERS) {
    try {
      const result = await runner.run();
      out.push({ id: runner.id, group: runner.group, title: runner.title, ...result, ...(runner.fix ? { fix: runner.fix.describe } : {}) });
    } catch (e) {
      out.push({
        id: runner.id,
        group: runner.group,
        title: runner.title,
        status: "fail",
        detail: `The check itself failed: ${(e as Error).message}`,
        ...(runner.fix ? { fix: runner.fix.describe } : {}),
      });
    }
  }
  return out;
}

export function fixableIds(): string[] {
  return RUNNERS.filter((r) => r.fix).map((r) => r.id);
}

/** Runs one repair. Unknown or unfixable ids are refused by the caller. */
export async function runFix(id: string): Promise<{ id: string; done: string }> {
  const runner = RUNNERS.find((r) => r.id === id);
  if (!runner?.fix) throw new Error(`No repair for "${id}".`);
  return { id, done: await runner.fix.run() };
}

/** Every repair, in order, skipping ones that only verify (mail). */
export async function runAllFixes(): Promise<{ id: string; done: string; failed?: string }[]> {
  const out: { id: string; done: string; failed?: string }[] = [];
  for (const runner of RUNNERS) {
    if (!runner.fix || runner.id === "mail") continue;
    try {
      out.push({ id: runner.id, done: await runner.fix.run() });
    } catch (e) {
      out.push({ id: runner.id, done: "", failed: (e as Error).message });
    }
  }
  return out;
}
