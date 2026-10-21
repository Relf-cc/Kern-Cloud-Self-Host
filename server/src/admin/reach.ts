// Which client addresses may reach the management API.
//
// Kept apart from guard.ts, which is middleware and pulls in configuration,
// the database and Better Auth. The rule itself is arithmetic on an address
// and a list, so it lives here where it can be read and tested on its own.

export interface ReachPolicy {
  /** Only the server's own machine, whatever the allow list says. */
  localOnly: boolean;
  /** Addresses and CIDR ranges, e.g. ["10.0.0.0/8", "192.168.1.5"]. */
  allowFrom: string[];
}

/** Strips an IPv4-mapped IPv6 prefix, so ::ffff:127.0.0.1 reads as 127.0.0.1. */
function plain(address: string): string {
  const a = address.trim().toLowerCase();
  return a.startsWith("::ffff:") ? a.slice(7) : a;
}

export function isLoopback(address: string): boolean {
  const a = plain(address);
  // 127.0.0.0/8 in full: a container's loopback isn't always 127.0.0.1.
  return a === "::1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(a);
}

function toInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/**
 * Matches an address against one rule: an exact address, or an IPv4 CIDR
 * range. IPv6 ranges are not implemented and never match - a prefix match
 * that is only half right would quietly let the wrong hosts in, and a
 * self-hosted allow list is a LAN range in practice.
 */
export function matches(address: string, rule: string): boolean {
  const a = plain(address);
  const r = plain(rule);
  if (!r) return false;
  const slash = r.indexOf("/");
  if (slash < 0) return a === r;
  const bits = Number.parseInt(r.slice(slash + 1), 10);
  if (!/^\d{1,2}$/.test(r.slice(slash + 1)) || bits > 32) return false;
  const ai = toInt(a);
  const ni = toInt(r.slice(0, slash));
  if (ai === null || ni === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ai & mask) === (ni & mask);
}

export function addressAllowed(address: string | null, policy: ReachPolicy): boolean {
  if (!address) return false;
  if (isLoopback(address)) return true;
  if (policy.localOnly) return false;
  return policy.allowFrom.some((rule) => matches(address, rule));
}
