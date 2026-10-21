// Settings an administrator can change while the server runs.
//
// `config` is the environment: it is read once at startup and never changes,
// which is right for addresses, secrets and the database. But an instance's
// name, who may sign up and the ceilings on usage are things an administrator
// wants to adjust from Kern Platform without editing .env and restarting.
//
// Those live in `kern_instance_setting` and are mirrored here in memory, so
// the rest of the server can read them synchronously (emails render inside
// template literals). The environment value is the default; a stored value
// overrides it, and clearing a stored value falls back to the environment.

import { query } from "./db.js";
import { config, type Registration, type WorkspaceKeys } from "./config.js";

export interface LiveSettings {
  /** What this instance calls itself, in emails and hand-off pages. */
  instanceName: string;
  /** Contact address for this instance, or "" for none. */
  supportEmail: string;
  /** How new accounts come about. */
  registration: Registration;
  /** Whether creating a workspace takes a minted key. */
  workspaceKeys: WorkspaceKeys;
  /** Sign-ups restricted to these email domains; empty means any. */
  allowedEmailDomains: string[];
  /** Accounts this instance will hold; 0 means no limit. */
  maxUsers: number;
  /** Public share links and calendar feeds. */
  sharesEnabled: boolean;
  /** A short notice shown on the invite hand-off page, or "". */
  motd: string;
}

/** Keys an administrator may set, with how each is parsed and serialised. */
const FIELDS = {
  instanceName: { parse: (v: string) => v.trim().slice(0, 80) || config.instanceName, write: (v: unknown) => String(v ?? "").trim().slice(0, 80) },
  supportEmail: { parse: (v: string) => v.trim().slice(0, 254), write: (v: unknown) => String(v ?? "").trim().slice(0, 254) },
  registration: {
    parse: (v: string) => (v === "open" || v === "closed" || v === "invite" ? (v as Registration) : config.registration),
    write: (v: unknown) => (v === "open" || v === "closed" || v === "invite" ? String(v) : ""),
  },
  workspaceKeys: {
    parse: (v: string) => (v === "required" || v === "off" ? (v as WorkspaceKeys) : config.workspaceKeys),
    write: (v: unknown) => (v === "required" || v === "off" ? String(v) : ""),
  },
  allowedEmailDomains: {
    parse: (v: string) => domains(v.split(",")),
    write: (v: unknown) => domains(Array.isArray(v) ? v.map(String) : String(v ?? "").split(",")).join(","),
  },
  maxUsers: { parse: (v: string) => clampInt(v, 0, 1_000_000, config.limits.users), write: (v: unknown) => String(clampInt(String(v ?? ""), 0, 1_000_000, 0)) },
  sharesEnabled: { parse: (v: string) => v === "true", write: (v: unknown) => String(v === true || v === "true") },
  motd: { parse: (v: string) => v.trim().slice(0, 500), write: (v: unknown) => String(v ?? "").trim().slice(0, 500) },
} satisfies Record<keyof LiveSettings, { parse: (v: string) => unknown; write: (v: unknown) => string }>;

export type LiveKey = keyof LiveSettings;
export const LIVE_KEYS = Object.keys(FIELDS) as LiveKey[];

function domains(parts: string[]): string[] {
  return [...new Set(parts.map((d) => d.trim().replace(/^@/, "").toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))].slice(0, 50);
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaults(): LiveSettings {
  return {
    instanceName: config.instanceName,
    supportEmail: config.supportEmail,
    registration: config.registration,
    workspaceKeys: config.workspaceKeys,
    allowedEmailDomains: config.allowedEmailDomains,
    maxUsers: config.limits.users,
    sharesEnabled: config.shares.enabled,
    motd: "",
  };
}

/**
 * The current settings. Read it as late as possible (inside the function that
 * needs a value) so a change from Kern Platform takes effect immediately.
 */
export const live: LiveSettings = defaults();

/** Which keys are currently overridden in the database, rather than by env. */
const stored = new Set<LiveKey>();

export async function loadLive(): Promise<void> {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM kern_instance_setting");
  Object.assign(live, defaults());
  stored.clear();
  for (const row of rows) {
    if (!(row.key in FIELDS)) continue;
    const key = row.key as LiveKey;
    (live as unknown as Record<string, unknown>)[key] = FIELDS[key].parse(row.value);
    stored.add(key);
  }
}

/** Applies and persists a partial change; returns the keys actually written. */
export async function setLive(patch: Partial<Record<LiveKey, unknown>>): Promise<LiveKey[]> {
  const written: LiveKey[] = [];
  for (const [rawKey, value] of Object.entries(patch)) {
    if (!(rawKey in FIELDS)) continue;
    const key = rawKey as LiveKey;
    if (value === null) {
      await query("DELETE FROM kern_instance_setting WHERE key = $1", [key]);
    } else {
      const text = FIELDS[key].write(value);
      await query(
        `INSERT INTO kern_instance_setting(key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
        [key, text],
      );
    }
    written.push(key);
  }
  if (written.length) await loadLive();
  return written;
}

/** Settings with their source, for the management API. */
export function liveWithSource(): Record<LiveKey, { value: unknown; source: "stored" | "env" }> {
  const out = {} as Record<LiveKey, { value: unknown; source: "stored" | "env" }>;
  for (const key of LIVE_KEYS) out[key] = { value: live[key], source: stored.has(key) ? "stored" : "env" };
  return out;
}
