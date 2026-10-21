// Spaces are the unit of sync and sharing: each user has one personal space,
// and any number of workspaces with members. Roles, from most to least:
// owner > admin > member > viewer. Viewers can read but not change records.

import { one, query, type Db } from "../db.js";
import { forbidden, iso, notFound } from "./http.js";

export type Role = "owner" | "admin" | "member" | "viewer";
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export interface SpaceRow {
  id: string;
  kind: "personal" | "workspace";
  owner_id: string;
  name: string;
  slug: string | null;
  description: string;
  logo: string | null;
  accent: string | null;
  website: string | null;
  industry: string | null;
  team_size: string | null;
  use_case: string | null;
  timezone: string | null;
  github_org: string | null;
  github_synced_at: Date | null;
  settings: Record<string, unknown>;
  seq: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface Membership {
  space: SpaceRow;
  role: Role;
}

export function serializeSpace(s: SpaceRow, role: Role, extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    slug: s.slug,
    description: s.description,
    logo: s.logo,
    accent: s.accent,
    website: s.website,
    industry: s.industry,
    teamSize: s.team_size,
    useCase: s.use_case,
    timezone: s.timezone,
    githubOrg: s.github_org,
    githubSyncedAt: iso(s.github_synced_at),
    settings: s.settings,
    ownerId: s.owner_id,
    role,
    head: s.seq,
    createdAt: iso(s.created_at),
    updatedAt: iso(s.updated_at),
    ...extra,
  };
}

/** Loads a live space the user belongs to, enforcing a minimum role. */
export async function membership(userId: string, spaceId: string, min: Role = "viewer", db?: Db): Promise<Membership> {
  if (!/^[0-9a-f-]{36}$/i.test(spaceId)) throw notFound("Workspace");
  const row = await one<SpaceRow & { role: Role }>(
    `SELECT s.*, m.role FROM kern_space s JOIN kern_member m ON m.space_id = s.id
     WHERE s.id = $1 AND m.user_id = $2 AND s.deleted_at IS NULL`,
    [spaceId, userId],
    db,
  );
  if (!row) throw notFound("Workspace");
  if (ROLE_RANK[row.role] < ROLE_RANK[min]) {
    throw forbidden(min === "admin" ? "Only workspace owners and admins can do that." : min === "owner" ? "Only the workspace owner can do that." : "You have read-only access to this workspace.");
  }
  const { role, ...space } = row;
  return { space: space as SpaceRow, role };
}

/** The user's personal space, created on first use. */
export async function ensurePersonal(user: { id: string; name: string }, db?: Db): Promise<SpaceRow> {
  const existing = await one<SpaceRow>("SELECT * FROM kern_space WHERE owner_id = $1 AND kind = 'personal'", [user.id], db);
  if (existing) return existing;
  const created = await one<SpaceRow>(
    `INSERT INTO kern_space(kind, owner_id, name) VALUES ('personal', $1, $2)
     ON CONFLICT (owner_id) WHERE kind = 'personal' DO UPDATE SET updated_at = kern_space.updated_at
     RETURNING *`,
    [user.id, "Personal"],
    db,
  );
  await query("INSERT INTO kern_member(space_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [created!.id, user.id], db);
  return created!;
}

export async function audit(spaceId: string, actorId: string | null, action: string, detail: Record<string, unknown> = {}, db?: Db) {
  await query("INSERT INTO kern_audit(space_id, actor_id, action, detail) VALUES ($1, $2, $3, $4)", [spaceId, actorId, action, JSON.stringify(detail)], db);
}

/** Ids of everyone in a space (for realtime notifications). */
export async function memberIds(spaceId: string, db?: Db): Promise<string[]> {
  const rows = await query<{ user_id: string }>("SELECT user_id FROM kern_member WHERE space_id = $1", [spaceId], db);
  return rows.map((r) => r.user_id);
}
