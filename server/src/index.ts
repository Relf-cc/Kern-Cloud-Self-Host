// Kern Cloud server entry point: migrate, then serve HTTP and WebSockets on
// one port (a reverse proxy or tunnel forwards both).
//
// Startup order matters. The log buffer is installed first so the management
// API can show what happened during startup; migrations run before anything
// reads a table; the live settings are loaded before the first email can be
// rendered; and the bootstrap management token is minted last, once there is a
// schema to put it in.

import { serve } from "@hono/node-server";
import { captureLog } from "./admin/log.js";
import { ensureBootstrapToken } from "./admin/tokens.js";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { live, loadLive } from "./live.js";
import { migrate } from "./migrate.js";
import { attachRealtime } from "./realtime.js";
import { collectUnusedAssets } from "./routes/assets.js";
import { sweepInbound } from "./routes/inbound.js";
import { sweepIngest } from "./routes/ingest.js";
import { pruneEvents } from "./streams/deliver.js";

/** Tells a new administrator what to do next, once, at the end of startup. */
function firstRunNotes(bootstrapToken: string | null) {
  if (bootstrapToken) {
    console.log("");
    console.log("  This instance had no management token, so here is one. It is shown once:");
    console.log("");
    console.log(`    ${bootstrapToken}`);
    console.log("");
    console.log("  Keep it somewhere safe. Kern Platform and kernctl use it to manage this");
    console.log("  server. Set ADMIN_TOKEN_FILE to have the next one written to disk instead.");
    console.log("");
  }
  if (config.mailToConsole) {
    console.log("[kern] SMTP_HOST isn't set: verification codes and invitations are printed here instead of sent.");
  }
  if (live.registration === "open") {
    console.log(
      live.allowedEmailDomains.length
        ? `[kern] Sign-ups are open to addresses at ${live.allowedEmailDomains.join(", ")}.`
        : "[kern] Sign-ups are open to anyone who can reach this server. Set REGISTRATION=invite to close that.",
    );
  }
}

async function main() {
  captureLog();
  await migrate();
  await loadLive();

  let realtime: ReturnType<typeof attachRealtime> | null = null;
  const app = createApp(() => realtime?.stats() ?? {});
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`[kern] ${live.instanceName} listening on http://${info.address}:${info.port}${config.basePath} (public ${config.publicUrl}${config.basePath})`);
  });
  realtime = attachRealtime(server);

  const bootstrap = await ensureBootstrapToken();
  firstRunNotes(bootstrap?.token ?? null);

  // Hourly: remove whiteboard images nothing refers to any more, and stream
  // delivery log entries past their retention.
  const gc = setInterval(() => {
    collectUnusedAssets()
      .then((n) => n && console.log(`[assets] removed ${n} unused image(s)`))
      .catch((e) => console.error("[assets] cleanup failed", e));
    pruneEvents()
      .then((n) => n && console.log(`[streams] pruned ${n} old delivery log entr${n === 1 ? "y" : "ies"}`))
      .catch((e) => console.error("[streams] log cleanup failed", e));
  }, 3_600_000);
  gc.unref();
  // Every minute: forget expired stream rate windows and signatures.
  const sweep = setInterval(() => {
    sweepIngest();
    sweepInbound();
  }, 60_000);
  sweep.unref();

  const shutdown = (signal: string) => {
    console.log(`[kern] ${signal} received, shutting down`);
    realtime?.close();
    server.close(() => void pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  console.error("[kern] failed to start", e);
  process.exit(1);
});
