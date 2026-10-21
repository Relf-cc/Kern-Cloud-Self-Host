/**
 * @Author Christian Relf
 * @Date 2026-10-21
 */

// Query setup.
//
// Everything on screen belongs to the server, so the only cache that makes
// sense is a short one: figures go stale in seconds, and switching server
// invalidates the lot. `domain` is the first element of every key, so one
// call can clear everything a change could have touched.

import { QueryClient } from "@tanstack/react-query";
import { errorCode } from "./ipc";

export type Domain = "ping" | "overview" | "health" | "settings" | "users" | "allow" | "spaces" | "invites" | "streams" | "tokens" | "logs" | "audit";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 120_000,
      refetchOnWindowFocus: true,
      retry: (attempt, error) => {
        // A refusal or a missing token won't fix itself by asking again.
        const code = errorCode(error);
        if (code === "auth" || code === "refused" || code === "invalid" || code === "not_found") return false;
        return attempt < 2;
      },
    },
  },
});

export function invalidate(...domains: Domain[]) {
  for (const domain of domains) void queryClient.invalidateQueries({ queryKey: [domain] });
}

/** Everything, for when the selected server changes. */
export function invalidateAll() {
  void queryClient.invalidateQueries();
}

/** A change that could show up almost anywhere (a repair, a restore). */
export function invalidateServerState() {
  invalidate("overview", "health", "users", "allow", "spaces", "invites", "streams", "settings", "audit");
}
