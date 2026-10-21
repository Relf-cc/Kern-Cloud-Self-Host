/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Turning the server's numbers and timestamps into something readable.
// Pure, so it can be tested without a window (format.test.ts).

/** 1536 -> "1.5 KB". Byte counts, as a person reads them. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 48213 -> "48,213". */
export function count(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "-";
}

/** 93784 -> "1d 2h". How long the server has been up. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** An ISO instant as "21 Oct 2026, 04:15". */
export function when(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Just the day: "21 Oct 2026". */
export function day(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * "4 minutes ago", "in 3 days". Used where the gap matters more than the
 * instant: when a token was last used, when an invitation runs out.
 */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const seconds = Math.round((now - t) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);
  const say = (n: number, unit: string) => {
    const plural = `${n} ${unit}${n === 1 ? "" : "s"}`;
    return future ? `in ${plural}` : `${plural} ago`;
  };
  if (abs < 45) return future ? "in a moment" : "just now";
  if (abs < 5400) return say(Math.round(abs / 60), "minute");
  if (abs < 129600) return say(Math.round(abs / 3600), "hour");
  if (abs < 2592000) return say(Math.round(abs / 86400), "day");
  if (abs < 31536000) return say(Math.round(abs / 2592000), "month");
  return say(Math.round(abs / 31536000), "year");
}

/** The host out of an API base, for the places that show it small. */
export function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A stream id or token: enough to recognise, not enough to use. */
export function shorten(value: string, lead = 8, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** "workspace" -> "Workspace". For a role or a kind out of the database. */
export function sentence(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}
