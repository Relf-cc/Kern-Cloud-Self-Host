// HTTP routes. Everything public lives under /kern/v1 (Better Auth at
// /kern/v1/auth/*), plus the invite hand-off page at /kern/invite/:id, share
// links at /kern/s/:id and calendar feeds at /kern/cal/:token.ics (served as
// LINK_URL), and stream endpoints at /kern/<64-hex id> with their phone
// capture pages at /kern/<id>/capture (served as STREAMS_URL). On a single-
// origin instance all of them are the one PUBLIC_URL.

import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { auth } from "./auth.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { HttpError, errorResponse } from "./lib/http.js";
import { live } from "./live.js";
import { admin, setAdminStats } from "./routes/admin.js";
import { assets } from "./routes/assets.js";
import { calendarFeeds, calendarPublic } from "./routes/calendar.js";
import { capture } from "./routes/capture.js";
import { inbound } from "./routes/inbound.js";
import { ingest } from "./routes/ingest.js";
import { instance } from "./routes/instance.js";
import { links } from "./routes/links.js";
import { sharePages, shares } from "./routes/shares.js";
import { streams } from "./routes/streams.js";
import { sync } from "./routes/sync.js";
import { workspaces } from "./routes/workspaces.js";

export function createApp(stats: () => Record<string, unknown> = () => ({})) {
  const app = new Hono();
  // The management API reports the same realtime figures as /health.
  setAdminStats(stats);

  app.use("*", secureHeaders({ crossOriginResourcePolicy: false }));
  // The desktop app talks to the API from its backend; the webview only opens
  // the realtime socket. CORS is still allowed for the app's own origins.
  app.use(
    `${config.basePath}/*`,
    cors({
      // The desktop app's own origins, plus anything a self-hoster adds for a
      // client of their own (EXTRA_CORS_ORIGINS).
      origin: ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420", ...config.extraOrigins],
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["set-auth-token"],
      maxAge: 600,
    }),
  );

  app.onError(errorResponse);
  app.notFound((c) => c.json({ code: "not_found", message: "Not found." }, 404));

  app.get(`${config.basePath}/health`, async (c) => {
    await pool.query("SELECT 1");
    return c.json({ ok: true, service: "kern-cloud", time: new Date().toISOString(), ...stats() });
  });

  app.on(["GET", "POST"], `${config.basePath}/auth/*`, (c) => auth.handler(c.req.raw));

  // What this server is, for an app that has only been given its address.
  app.route("/", instance);
  // Management, for Kern Platform and kernctl. Loopback-only by default; see
  // admin/guard.ts.
  app.route(`${config.basePath}/admin`, admin);

  app.route("/", links);
  // Publishing can be turned off for the whole instance (SHARES_ENABLED, or
  // from Kern Platform). Checked per request, because it is a live setting:
  // turning it off has to stop serving pages that are already out there.
  const sharesOn: MiddlewareHandler = async (_c, next) => {
    if (!live.sharesEnabled) throw new HttpError(403, "shares_disabled", "Publishing is turned off on this server.");
    await next();
  };
  // Public read-only pages: share links and calendar feeds (LINK_URL).
  app.use("/kern/s/*", sharesOn);
  app.use("/kern/cal/*", sharesOn);
  app.use(`${config.basePath}/shares`, sharesOn);
  app.use(`${config.basePath}/shares/*`, sharesOn);
  app.use(`${config.basePath}/spaces/:space/calendar-feed`, sharesOn);
  app.route("/", sharePages);
  app.route("/", calendarPublic);
  // The phone capture page lives next to its stream (STREAMS_URL).
  app.route("/", capture);
  // Email arriving for streams, from the inbound email worker.
  app.route("/", inbound);
  // Stream endpoints answer any website (each stream has its own CORS rules).
  app.route("/", ingest);
  app.route(config.basePath, workspaces);
  app.route(`${config.basePath}/spaces`, sync);
  app.route(`${config.basePath}/spaces`, assets);
  app.route(`${config.basePath}/spaces`, streams);
  app.route(`${config.basePath}/spaces`, calendarFeeds);
  app.route(`${config.basePath}/shares`, shares);

  return app;
}
