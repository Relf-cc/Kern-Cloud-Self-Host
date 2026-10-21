// Recent server log, kept in memory so a headless instance can be looked at
// without shell access to the container.
//
// `console.log` and friends are wrapped once at startup: the line still goes
// to stdout (journald, docker logs, your log shipper) and a copy lands in a
// ring buffer of the last ADMIN_LOG_LINES entries. Nothing is written to disk
// here, so this is a window on a running process, not an audit trail: it is
// empty after a restart, which is exactly what you want from something an
// administrator can read over the management API.

import { config } from "../config.js";

export type Level = "info" | "warn" | "error";

export interface Line {
  /** Monotonic within one process run, so a client can poll for new lines. */
  n: number;
  at: string;
  level: Level;
  text: string;
}

const lines: Line[] = [];
let counter = 0;
let installed = false;

/** Secrets that must never end up in a buffer an API hands out. */
const REDACT: [RegExp, string][] = [
  [/kern_[0-9a-f]{16}_[A-Za-z0-9_-]{32,96}/g, "kern_<token>"],
  [/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1<password>@"],
  [/\b([A-Za-z0-9._-]*(?:secret|token|password|passwd|apikey|api_key)[A-Za-z0-9._-]*\s*[=:]\s*)\S+/gi, "$1<redacted>"],
  [/\b\d{6}\b(?=[^\d]|$)/g, "<code>"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACT) out = out.replace(pattern, replacement);
  return out;
}

function push(level: Level, args: unknown[]): void {
  const text = redact(
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ")
      .slice(0, 4000),
  );
  lines.push({ n: ++counter, at: new Date().toISOString(), level, text });
  if (lines.length > config.admin.logLines) lines.splice(0, lines.length - config.admin.logLines);
}

/** Wraps the console once. Safe to call again; it does nothing the second time. */
export function captureLog(): void {
  if (installed) return;
  installed = true;
  const bind = (level: Level, original: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  console.log = bind("info", console.log.bind(console));
  console.info = bind("info", console.info.bind(console));
  console.warn = bind("warn", console.warn.bind(console));
  console.error = bind("error", console.error.bind(console));
}

/** Lines after `since` (0 for everything held), newest last. */
export function tail(opts: { since?: number; limit?: number; level?: Level } = {}): { lines: Line[]; latest: number; held: number } {
  const since = opts.since ?? 0;
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), config.admin.logLines);
  let out = lines.filter((l) => l.n > since);
  if (opts.level === "warn") out = out.filter((l) => l.level !== "info");
  else if (opts.level === "error") out = out.filter((l) => l.level === "error");
  return { lines: out.slice(-limit), latest: counter, held: lines.length };
}
