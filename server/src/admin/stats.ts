// What an instance looks like right now: the numbers Kern Platform's Overview
// and `kernctl status` show.
//
// Everything here is aggregate. A management token can look up a particular
// account (admin/users) but these summaries deliberately hold no record
// contents: an administrator keeps a server running without reading what
// people wrote in it.

import { one, query } from "../db.js";
import { config } from "../config.js";
import { live } from "../live.js";

export interface Overview {
  instance: {
    name: string;
    publicUrl: string;
    basePath: string;
    /** The address the Kern app is given to sign in to this instance. */
    apiUrl: string;
    version: string;
    registration: string;
    startedAt: string;
    uptimeSeconds: number;
    nodeVersion: string;
    platform: string;
  };
  accounts: { total: number; verified: number; held: number; newThisWeek: number; limit: number };
  spaces: { personal: number; workspaces: number; deleted: number; records: number; tombstones: number };
  collaboration: { members: number; openInvites: number; sharedWorkspaces: number };
  streams: { total: number; enabled: number; deliveriesToday: number; failuresToday: number };
  shares: { links: number; calendarFeeds: number; enabled: boolean };
  storage: { databaseBytes: number; assetBytes: number; assetCount: number; shareImageBytes: number };
  realtime: Record<string, unknown>;
  mail: { configured: boolean; from: string };
}

const started = Date.now();

const num = async (sql: string, params: unknown[] = []): Promise<number> => {
  const row = await one<{ n: string | number | null }>(sql, params);
  return Number(row?.n ?? 0);
};

export function instanceVersion(): string {
  return process.env.KERN_SERVER_VERSION?.trim() || "dev";
}

/** The one address a person types into Kern to use this server. */
export function apiUrl(): string {
  return `${config.publicUrl}${config.basePath}`;
}

export async function overview(realtime: Record<string, unknown>): Promise<Overview> {
  const [accounts, spaces, records, streams, assets, shares] = await Promise.all([
    one<{ total: string; verified: string; recent: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE "emailVerified") AS verified,
              count(*) FILTER (WHERE "createdAt" > now() - interval '7 days') AS recent
       FROM "user"`,
    ),
    one<{ personal: string; workspaces: string; deleted: string; shared: string }>(
      `SELECT count(*) FILTER (WHERE kind = 'personal' AND deleted_at IS NULL) AS personal,
              count(*) FILTER (WHERE kind = 'workspace' AND deleted_at IS NULL) AS workspaces,
              count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted,
              count(*) FILTER (WHERE kind = 'workspace' AND deleted_at IS NULL
                AND (SELECT count(*) FROM kern_member m WHERE m.space_id = kern_space.id) > 1) AS shared
       FROM kern_space`,
    ),
    one<{ total: string; tombstones: string }>(`SELECT count(*) AS total, count(*) FILTER (WHERE deleted) AS tombstones FROM kern_record`),
    one<{ total: string; enabled: string; today: string; failed: string }>(
      `SELECT (SELECT count(*) FROM kern_stream) AS total,
              (SELECT count(*) FROM kern_stream WHERE enabled) AS enabled,
              (SELECT count(*) FROM kern_stream_event WHERE received_at > now() - interval '24 hours') AS today,
              (SELECT count(*) FROM kern_stream_event WHERE received_at > now() - interval '24 hours' AND status IN ('failed', 'rejected')) AS failed`,
    ),
    one<{ n: string; size: string }>(`SELECT count(*) AS n, coalesce(sum(size), 0)::text AS size FROM kern_asset`),
    one<{ links: string; feeds: string; images: string }>(
      `SELECT (SELECT count(*) FROM kern_share WHERE revoked_at IS NULL) AS links,
              (SELECT count(*) FROM kern_calendar_feed) AS feeds,
              (SELECT coalesce(sum(octet_length(image)), 0)::text FROM kern_share WHERE image IS NOT NULL) AS images`,
    ),
  ]);
  const [held, members, invites, dbSize] = await Promise.all([
    num("SELECT count(*) AS n FROM kern_account_hold"),
    num("SELECT count(*) AS n FROM kern_member"),
    num("SELECT count(*) AS n FROM kern_invite WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at > now()"),
    num("SELECT pg_database_size(current_database())::text AS n"),
  ]);
  return {
    instance: {
      name: live.instanceName,
      publicUrl: config.publicUrl,
      basePath: config.basePath,
      apiUrl: apiUrl(),
      version: instanceVersion(),
      registration: live.registration,
      startedAt: new Date(started).toISOString(),
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    accounts: {
      total: Number(accounts?.total ?? 0),
      verified: Number(accounts?.verified ?? 0),
      held,
      newThisWeek: Number(accounts?.recent ?? 0),
      limit: live.maxUsers,
    },
    spaces: {
      personal: Number(spaces?.personal ?? 0),
      workspaces: Number(spaces?.workspaces ?? 0),
      deleted: Number(spaces?.deleted ?? 0),
      records: Number(records?.total ?? 0),
      tombstones: Number(records?.tombstones ?? 0),
    },
    collaboration: { members, openInvites: invites, sharedWorkspaces: Number(spaces?.shared ?? 0) },
    streams: {
      total: Number(streams?.total ?? 0),
      enabled: Number(streams?.enabled ?? 0),
      deliveriesToday: Number(streams?.today ?? 0),
      failuresToday: Number(streams?.failed ?? 0),
    },
    shares: { links: Number(shares?.links ?? 0), calendarFeeds: Number(shares?.feeds ?? 0), enabled: live.sharesEnabled },
    storage: {
      databaseBytes: dbSize,
      assetBytes: Number(assets?.size ?? 0),
      assetCount: Number(assets?.n ?? 0),
      shareImageBytes: Number(shares?.images ?? 0),
    },
    realtime,
    mail: { configured: !config.mailToConsole, from: config.mail.from },
  };
}

/** Daily activity for the last `days` days, for the Overview chart. */
export async function activity(days = 30): Promise<{ day: string; signUps: number; deliveries: number; changes: number }[]> {
  const span = Math.min(Math.max(days, 1), 365);
  const rows = await query<{ day: string; sign_ups: string; deliveries: string; changes: string }>(
    `WITH span AS (SELECT generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date AS day)
     SELECT to_char(span.day, 'YYYY-MM-DD') AS day,
            (SELECT count(*) FROM "user" u WHERE u."createdAt"::date = span.day) AS sign_ups,
            (SELECT count(*) FROM kern_stream_event e WHERE e.received_at::date = span.day) AS deliveries,
            (SELECT count(*) FROM kern_record r WHERE r.updated_at::date = span.day) AS changes
     FROM span ORDER BY span.day`,
    [span],
  );
  return rows.map((r) => ({ day: r.day, signUps: Number(r.sign_ups), deliveries: Number(r.deliveries), changes: Number(r.changes) }));
}
