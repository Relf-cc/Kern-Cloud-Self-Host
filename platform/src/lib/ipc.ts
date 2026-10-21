/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// The typed client for the back end.
//
// Nothing in the interface calls `invoke` directly, and nothing in the
// interface knows a management token exists: `api.admin.*` names a path and
// the back end attaches the token for whichever server is selected. The same
// division Kern uses for its session token.

import { invoke } from "@tauri-apps/api/core";
import type * as T from "./types";

export interface KernError {
  code: string;
  message: string;
}

function isKernError(e: unknown): e is KernError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

async function call<R>(command: string, args?: Record<string, unknown>): Promise<R> {
  return invoke<R>(command, args);
}

/** The path for a list endpoint, with the query it was given. */
function withQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `${path}?${parts.join("&")}` : path;
}

export const api = {
  servers: {
    list: () => call<T.Server[]>("servers_list"),
    /** Looks at an address without saving it. */
    probe: (url: string) => call<T.InstanceProbe>("server_probe", { url }),
    add: (name: string, url: string, token?: string) => call<T.Server>("server_add", { name, url, token: token ?? null }),
    /** Adds one from the line `kernctl pair` prints. */
    pair: (line: string) => call<T.Server>("server_pair", { line }),
    select: (id: string) => call<T.Server>("server_select", { id }),
    rename: (id: string, name: string) => call<T.Server>("server_rename", { id, name }),
    remove: (id: string) => call<void>("server_remove", { id }),
    setToken: (id: string, token: string) => call<void>("server_set_token", { id, token }),
    hasToken: (id: string) => call<boolean>("server_has_token", { id }),
    note: (id: string, instanceName?: string, version?: string) =>
      call<void>("server_note", { id, instanceName: instanceName ?? null, version: version ?? null }),
  },

  admin: {
    // ----- identity and figures
    ping: () => call<T.Ping>("admin_get", { path: "/ping" }),
    overview: () => call<T.Overview>("admin_get", { path: "/overview" }),
    activity: (days = 30) => call<{ days: number; series: T.ActivityDay[] }>("admin_get", { path: `/activity?days=${days}` }),

    // ----- health
    health: () => call<T.Health>("admin_get", { path: "/health" }),
    fix: (id: string) => call<{ results: T.FixResult[] }>("admin_send", { method: "POST", path: "/health/fix", body: { id } }),
    fixAll: () => call<{ results: T.FixResult[] }>("admin_send", { method: "POST", path: "/health/fix", body: { all: true } }),

    // ----- settings
    settings: () => call<T.SettingsReply>("admin_get", { path: "/settings" }),
    setSettings: (patch: Partial<Record<T.SettingKey, unknown>>) =>
      call<{ settings: T.SettingsReply["settings"]; changed: string[] }>("admin_send", { method: "PATCH", path: "/settings", body: patch }),

    // ----- people
    users: (opts: { q?: string; filter?: "held" | "unverified" | ""; limit?: number } = {}) =>
      call<{ users: T.User[]; total: number; limit: number; offset: number }>("admin_get", {
        path: withQuery("/users", { q: opts.q, filter: opts.filter, limit: opts.limit ?? 200 }),
      }),
    user: (id: string) => call<T.UserDetail>("admin_get", { path: `/users/${encodeURIComponent(id)}` }),
    hold: (id: string, reason: string) =>
      call<{ user: T.User }>("admin_send", { method: "POST", path: `/users/${encodeURIComponent(id)}/hold`, body: { reason } }),
    release: (id: string) => call<{ user: T.User }>("admin_send", { method: "DELETE", path: `/users/${encodeURIComponent(id)}/hold` }),
    verify: (id: string) => call<{ user: T.User }>("admin_send", { method: "POST", path: `/users/${encodeURIComponent(id)}/verify`, body: {} }),
    revokeSessions: (id: string) =>
      call<{ revoked: number }>("admin_send", { method: "POST", path: `/users/${encodeURIComponent(id)}/sessions/revoke`, body: {} }),
    /** `confirm` is the account's own email address, so a misclick can't land. */
    deleteUser: (id: string, confirm: string, withWorkspaces = false) =>
      call<{ deleted: boolean; email: string; spacesRemoved: number }>("admin_send", {
        method: "DELETE",
        path: withQuery(`/users/${encodeURIComponent(id)}`, { withWorkspaces: withWorkspaces || undefined }),
        body: { confirm },
      }),

    allow: () => call<{ registration: T.Registration; allowed: T.AllowEntry[] }>("admin_get", { path: "/allow" }),
    addAllow: (email: string, note: string) => call<{ email: string }>("admin_send", { method: "POST", path: "/allow", body: { email, note } }),
    removeAllow: (email: string) => call<{ removed: string }>("admin_send", { method: "DELETE", path: `/allow/${encodeURIComponent(email)}` }),

    // ----- their work
    spaces: (opts: { q?: string; kind?: "personal" | "workspace" | ""; deleted?: boolean } = {}) =>
      call<{ spaces: T.Space[]; limit: number; offset: number }>("admin_get", {
        path: withQuery("/spaces", { q: opts.q, kind: opts.kind, deleted: opts.deleted || undefined, limit: 200 }),
      }),
    space: (id: string) => call<T.SpaceDetail>("admin_get", { path: `/spaces/${encodeURIComponent(id)}` }),
    /** `confirm` is the workspace's own name. */
    deleteSpace: (id: string, confirm: string, purge = false) =>
      call<{ id: string; name: string; purged: boolean }>("admin_send", {
        method: "DELETE",
        path: withQuery(`/spaces/${encodeURIComponent(id)}`, { purge: purge || undefined }),
        body: { confirm },
      }),

    invites: () => call<{ invites: T.Invite[] }>("admin_get", { path: "/invites?limit=200" }),
    revokeInvite: (id: string) => call<{ revoked: string }>("admin_send", { method: "DELETE", path: `/invites/${encodeURIComponent(id)}` }),

    streams: () => call<{ streams: T.Stream[] }>("admin_get", { path: "/streams?limit=200" }),
    setStream: (id: string, enabled: boolean) =>
      call<{ id: string; enabled: boolean }>("admin_send", { method: "PATCH", path: `/streams/${encodeURIComponent(id)}`, body: { enabled } }),

    // ----- management tokens
    tokens: () => call<{ tokens: T.Token[] }>("admin_get", { path: "/tokens" }),
    mintToken: (name: string, scope: T.Scope, days: number | null) =>
      call<T.MintedToken>("admin_send", { method: "POST", path: "/tokens", body: { name, scope, days } }),
    revokeToken: (id: string) => call<{ revoked: string }>("admin_send", { method: "DELETE", path: `/tokens/${encodeURIComponent(id)}` }),

    // ----- watching
    logs: (since: number, level?: "warn" | "error") =>
      call<T.LogReply>("admin_get", { path: withQuery("/logs", { since, limit: 400, level }) }),
    audit: () => call<{ entries: T.AuditEntry[] }>("admin_get", { path: "/audit?limit=100" }),
    notice: (message: string, level: "info" | "warn") =>
      call<{ sent: boolean; to: string }>("admin_send", { method: "POST", path: "/notice", body: { message, level } }),
    query: (sql: string) => call<T.QueryReply>("admin_send", { method: "POST", path: "/query", body: { sql, limit: 200 } }),
  },
};

/**
 * Turns an error from a command into something to put on screen. The server
 * writes its own refusals carefully, so the message is used as it stands; this
 * only fills in for the cases that arrive with nothing useful.
 */
export function describeError(e: unknown, fallback = "That didn't work."): string {
  if (isKernError(e)) {
    if (e.message?.trim()) return e.message;
    switch (e.code) {
      case "auth":
        return "This server didn't accept the management token. Mint a new one with `kernctl token new` and paste it in Settings.";
      case "network":
        return "The server couldn't be reached.";
      case "refused":
        return "The server refused that.";
      case "not_found":
        return "That isn't there any more.";
      default:
        return fallback;
    }
  }
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e.trim()) return e;
  return fallback;
}

/** The stable code, for the few places that branch on it. */
export function errorCode(e: unknown): string {
  return isKernError(e) ? e.code : "unknown";
}
