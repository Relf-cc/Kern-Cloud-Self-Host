/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The shapes the management API returns, mirrored by hand.
//
// Two seams to keep in step, and `tsc` catches neither, because both are
// untyped at the boundary:
//
//   server/src/routes/admin.ts   what the API sends
//   src-tauri/src/servers.rs     what the back end sends (serde camelCase)
//
// Change one side and change this file.

// ------------------------------------------------------------------ servers

export interface Server {
  id: string;
  name: string;
  /** The API base, e.g. http://127.0.0.1:8787/kern/v1 */
  url: string;
  instanceName: string | null;
  version: string | null;
  lastConnectedAt: number | null;
  hasToken: boolean;
  /** Set when the address works but isn't encrypted. */
  warning: string | null;
  selected: boolean;
}

/** What GET /instance says, before any token exists. */
export interface InstanceProbe {
  service: string;
  protocol: number;
  name: string;
  apiUrl: string;
  registration: Registration;
  emailDomains?: string[];
  notice?: string;
  contact?: string;
  features: {
    workspaces: boolean;
    assets: boolean;
    streams: boolean;
    shares: boolean;
    inboundEmail: boolean;
    email: boolean;
  };
}

// ----------------------------------------------------------------- overview

export type Registration = "open" | "invite" | "closed";

export interface Overview {
  instance: {
    name: string;
    publicUrl: string;
    basePath: string;
    apiUrl: string;
    version: string;
    registration: Registration;
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
  realtime: { connections?: number; rooms?: number };
  mail: { configured: boolean; from: string };
}

export interface ActivityDay {
  day: string;
  signUps: number;
  deliveries: number;
  changes: number;
}

export interface Ping {
  ok: boolean;
  instance: string;
  version: string;
  apiUrl: string;
  token: { id: string; name: string; scope: Scope };
  time: string;
}

// ------------------------------------------------------------------- health

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  group: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What running the repair would do; absent when there isn't one. */
  fix?: string;
  facts?: Record<string, string | number>;
}

export interface Health {
  status: CheckStatus;
  checks: Check[];
  fixable: string[];
}

export interface FixResult {
  id: string;
  done: string;
  failed?: string;
}

// ----------------------------------------------------------------- settings

export interface LiveSetting<T = unknown> {
  value: T;
  /** "stored" is set here; "env" still follows .env. */
  source: "stored" | "env";
}

export interface SettingsReply {
  settings: {
    instanceName: LiveSetting<string>;
    supportEmail: LiveSetting<string>;
    registration: LiveSetting<Registration>;
    workspaceKeys: LiveSetting<"off" | "required">;
    allowedEmailDomains: LiveSetting<string[]>;
    maxUsers: LiveSetting<number>;
    sharesEnabled: LiveSetting<boolean>;
    motd: LiveSetting<string>;
  };
  environment: {
    publicUrl: string;
    linkUrl: string;
    streamsUrl: string;
    apiUrl: string;
    appScheme: string;
    port: number;
    host: string;
    mail: { configured: boolean; host: string; port: number; from: string };
    inboundEmail: { enabled: boolean; domain: string };
    admin: { localOnly: boolean; allowFrom: string[]; tokenFile: string | null };
    limits: Record<string, number>;
    inviteDays: number;
    streamsKeySet: boolean;
  };
  keys: string[];
}

export type SettingKey = keyof SettingsReply["settings"];

// -------------------------------------------------------------------- users

export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  hasImage: boolean;
  createdAt: string | null;
  held: boolean;
  holdReason: string | null;
  spaces: number;
  activeSessions: number;
  records: number;
}

export interface UserDetail {
  user: User;
  spaces: { id: string; kind: string; name: string; role: string; members: number; records: number }[];
  sessions: { id: string; createdAt: string | null; expiresAt: string | null; ip: string | null; client: string | null }[];
}

export interface AllowEntry {
  email: string;
  note: string;
  createdAt: string | null;
  usedAt: string | null;
}

// ------------------------------------------------------------------- spaces

export interface Space {
  id: string;
  kind: "personal" | "workspace";
  name: string;
  owner: { id: string; email: string };
  members: number;
  records: number;
  tombstones: number;
  assets: number;
  assetBytes: number;
  streams: number;
  head: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
}

export interface SpaceDetail {
  space: { id: string; kind: string; name: string; ownerId: string; head: number; createdAt: string | null; deletedAt: string | null };
  members: { id: string; email: string; name: string; role: string; joinedAt: string | null }[];
  tables: { table: string; records: number; tombstones: number }[];
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  workspace: { id: string; name: string };
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  createdAt: string | null;
  expiresAt: string | null;
}

export interface Stream {
  /** Shortened for display; `fullId` is the endpoint path, and a secret. */
  id: string;
  fullId: string;
  name: string;
  enabled: boolean;
  workspace: { id: string; name: string };
  deliveries: number;
  failuresThisWeek: number;
  lastDeliveryAt: string | null;
  createdAt: string | null;
}

// ------------------------------------------------------------------- tokens

export type Scope = "full" | "read";

export interface Token {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  current: boolean;
}

/** Only ever returned once, by POST /tokens. */
export interface MintedToken {
  token: string;
  id: string;
  name: string;
  scope: Scope;
  expiresAt: string | null;
}

// ------------------------------------------------------- workspace keys

/**
 * A workspace key. While the instance requires them, creating a workspace
 * takes one; joining somebody else's never does. A key is claimed by the
 * first account that uses it and refused to every other one afterwards.
 */
export interface WorkspaceKey {
  id: string;
  note: string;
  createdAt: string | null;
  redeemedBy: string | null;
  redeemedEmail: string | null;
  redeemedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
  revokedAt: string | null;
}

export interface WorkspaceKeys {
  /** Whether the gate is actually on; keys can be minted before it is. */
  required: boolean;
  counts: { total: number; usable: number; redeemed: number; revoked: number };
  keys: WorkspaceKey[];
}

/** Only ever returned once, by POST /workspace-keys. */
export interface MintedWorkspaceKey {
  key: string;
  id: string;
  note: string;
}

// --------------------------------------------------------------- log, audit

export interface LogLine {
  n: number;
  at: string;
  level: "info" | "warn" | "error";
  text: string;
}

export interface LogReply {
  lines: LogLine[];
  latest: number;
  held: number;
}

export interface AuditEntry {
  id: number;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  by: string | null;
  ip: string | null;
  at: string | null;
}

export interface QueryReply {
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
