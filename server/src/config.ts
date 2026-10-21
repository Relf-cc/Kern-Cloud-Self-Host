// Environment configuration. Everything the server needs comes from env
// variables (see .env.example); missing required values stop startup with a
// clear message instead of failing later.
//
// A self-hosted instance normally runs behind one origin, so PUBLIC_URL is the
// only address that has to be set: invite links, stream endpoints and the
// capture pages all default to it. Split them only if you really do serve them
// from different hostnames.

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function list(name: string): string[] {
  return optional(name, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** How new accounts come about on this instance. */
export type Registration = "open" | "invite" | "closed";

function registration(): Registration {
  const v = optional("REGISTRATION", "invite").toLowerCase();
  return v === "open" || v === "closed" ? v : "invite";
}

function load() {
  const port = int("PORT", 8787);
  const publicUrl = optional("PUBLIC_URL", `http://localhost:${port}`).replace(/\/+$/, "");
  // Invite links, stream endpoints and their capture pages are served by this
  // same process; they need their own origin only behind a reverse proxy that
  // splits them across hostnames.
  const linkUrl = optional("LINK_URL", publicUrl).replace(/\/+$/, "");
  const streamsUrl = optional("STREAMS_URL", publicUrl).replace(/\/+$/, "");
  return {
    port,
    // "::" listens on IPv6 and IPv4 (localhost may resolve to either).
    host: optional("HOST", "::"),
    /** Public origin of the API, as people and apps reach it. */
    publicUrl,
    /** Every route lives under this prefix. */
    basePath: "/kern/v1",
    /** Public origin for shareable links (invites, share pages, calendars). */
    linkUrl,
    /** Public origin for stream endpoints (<streamsUrl>/kern/<id>). */
    streamsUrl,
    /**
     * Where the stream documentation lives, linked from rejection replies so
     * whoever is wiring up a form can read why. Point it at your own copy of
     * docs/streams.md if you publish one.
     */
    streamsDocsUrl: optional("STREAMS_DOCS_URL", "https://github.com/Relf-cc/Kern-Cloud-Self-Host/blob/main/docs/streams.md"),
    /**
     * What this instance calls itself: shown in emails, on the hand-off pages
     * and in Kern Platform. Name it after the team or the host.
     */
    instanceName: optional("INSTANCE_NAME", "Kern Self-Host"),
    /** Who to contact about this instance (optional; shown in emails). */
    supportEmail: optional("SUPPORT_EMAIL", ""),
    /** open: anyone may sign up. invite: only invited addresses. closed: nobody. */
    registration: registration(),
    /**
     * When registration is "open", optionally restrict sign-ups to these email
     * domains (comma separated, no "@"). Empty means any domain.
     */
    allowedEmailDomains: list("ALLOWED_EMAIL_DOMAINS").map((d) => d.replace(/^@/, "").toLowerCase()),
    /**
     * Key that encrypts stream secrets and GitHub tokens at rest (32 bytes,
     * base64). Without it a key is derived from BETTER_AUTH_SECRET, so
     * rotating that secret makes stored stream credentials unreadable.
     */
    streamsKey: optional("STREAMS_ENCRYPTION_KEY", ""),
    /** GitHub's REST API (overridable for tests and GitHub Enterprise). */
    githubApi: optional("GITHUB_API_URL", "https://api.github.com").replace(/\/+$/, ""),
    /** Custom URL scheme the desktop app registers. */
    appScheme: optional("APP_SCHEME", "kern"),
    /** Where people get the app when an invite link opens without it installed. */
    downloadUrl: optional("DOWNLOAD_URL", "https://github.com/kern-platform/kern/releases/latest"),
    databaseUrl: required("DATABASE_URL"),
    authSecret: required("BETTER_AUTH_SECRET"),
    /**
     * Extra origins allowed to call the API with credentials. The desktop
     * app's own origins are always allowed; add a hostname here only if you
     * build your own client.
     */
    extraOrigins: list("EXTRA_CORS_ORIGINS"),
    admin: {
      /**
       * Management API (/kern/v1/admin/*): Kern Platform and kernctl talk to
       * this. Loopback-only by default, which is why the desktop app connects
       * over 127.0.0.1 or an SSH tunnel rather than an open port.
       */
      localOnly: bool("ADMIN_LOCAL_ONLY", true),
      /**
       * Addresses or CIDR ranges allowed to reach the management API when it
       * isn't loopback-only (e.g. "10.0.0.0/8,192.168.1.5").
       */
      allowFrom: list("ADMIN_ALLOW_FROM"),
      /**
       * A first management token is written here on first start, when no
       * tokens exist yet, so kernctl and Kern Platform can connect without a
       * password. Keep the file readable only by the service account.
       */
      tokenFile: optional("ADMIN_TOKEN_FILE", ""),
      /** Lines of recent server log kept in memory for the management API. */
      logLines: int("ADMIN_LOG_LINES", 2000),
    },
    mail: {
      host: optional("SMTP_HOST", ""),
      port: int("SMTP_PORT", 587),
      secure: bool("SMTP_SECURE", false),
      user: optional("SMTP_USER", ""),
      pass: optional("SMTP_PASS", ""),
      from: optional("MAIL_FROM", "Kern <no-reply@localhost>"),
    },
    limits: {
      /** Largest accepted JSON body for sync pushes. */
      pushBytes: int("SYNC_MAX_PUSH_BYTES", 4 * 1024 * 1024),
      pushChanges: int("SYNC_MAX_PUSH_CHANGES", 2000),
      pullPage: int("SYNC_PULL_PAGE", 1000),
      /** Workspace logos are stored as data URLs. */
      logoBytes: int("LOGO_MAX_BYTES", 300 * 1024),
      /** Largest accepted (already compressed) whiteboard image. */
      assetBytes: int("ASSET_MAX_BYTES", 3 * 1024 * 1024),
      /** Total image storage per space. */
      assetQuotaBytes: int("ASSET_QUOTA_MB", 1024) * 1024 * 1024,
      workspacesPerUser: int("WORKSPACES_PER_USER", 25),
      membersPerWorkspace: int("MEMBERS_PER_WORKSPACE", 200),
      /** Accounts this instance will hold; 0 means no limit. */
      users: int("MAX_USERS", 0),
      streamsPerSpace: int("STREAMS_PER_SPACE", 25),
      /** Hard ceiling for one stream submission; each stream sets its own lower limit. */
      streamBodyBytes: int("STREAM_MAX_BODY_BYTES", 256 * 1024),
      /** Submissions per stream per hour, whatever the stream's own setting. */
      streamHourly: int("STREAM_MAX_PER_HOUR", 1000),
      /** Delivery log entries are never kept longer than this. */
      streamLogDays: int("STREAM_LOG_MAX_DAYS", 90),
      /** Emails accepted per stream per hour. */
      emailHourly: int("STREAM_EMAIL_PER_HOUR", 120),
    },
    inviteDays: int("INVITE_EXPIRY_DAYS", 14),
    /**
     * Email to streams: an email worker (deploy/email-worker.js) posts each
     * message to /kern/v1/inbound/email with this secret. Empty turns the
     * feature off. Addresses look like <alias>@<domain>.
     */
    inboundEmail: {
      secret: optional("INBOUND_EMAIL_SECRET", ""),
      domain: optional("INBOUND_EMAIL_DOMAIN", ""),
    },
    shares: {
      /** Largest shared page (JSON) and whiteboard image. */
      contentBytes: int("SHARE_MAX_CONTENT_BYTES", 512 * 1024),
      imageBytes: int("SHARE_MAX_IMAGE_BYTES", 4 * 1024 * 1024),
      perUser: int("SHARES_PER_USER", 200),
      /** Public share links and calendar feeds can be turned off entirely. */
      enabled: bool("SHARES_ENABLED", true),
    },
    /** Log outgoing mail to stdout instead of sending (no SMTP configured). */
    get mailToConsole() {
      return !this.mail.host;
    },
  };
}

export const config = load();
export type Config = typeof config;
