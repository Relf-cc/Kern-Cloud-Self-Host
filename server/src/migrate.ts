// Schema migrations. Better Auth's own tables (user, session, account,
// verification) are created by its migrator first; Kern's tables follow as
// numbered, transactional steps recorded in kern_migration.

import { getMigrations } from "better-auth/db/migration";
import { pool } from "./db.js";
import { authOptions } from "./auth.js";

const STEPS: string[] = [
  // 1: spaces (personal areas and workspaces), membership, invitations and
  //    the synced record store.
  `
  CREATE TABLE kern_space (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('personal', 'workspace')),
    owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name text NOT NULL,
    slug text,
    description text NOT NULL DEFAULT '',
    logo text,
    accent text,
    website text,
    industry text,
    team_size text,
    use_case text,
    timezone text,
    github_org text,
    github_synced_at timestamptz,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Highest change sequence number in this space. Pushes take a row lock
    -- here, so sequence numbers are contiguous and commit in order.
    seq bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
  );
  CREATE UNIQUE INDEX kern_space_personal ON kern_space(owner_id) WHERE kind = 'personal';
  CREATE UNIQUE INDEX kern_space_slug ON kern_space(lower(slug)) WHERE slug IS NOT NULL AND deleted_at IS NULL;

  CREATE TABLE kern_member (
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    title text,
    invited_by text REFERENCES "user"(id) ON DELETE SET NULL,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (space_id, user_id)
  );
  CREATE INDEX kern_member_user ON kern_member(user_id);

  CREATE TABLE kern_invite (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
    message text,
    invited_by text REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_sent_at timestamptz,
    send_count int NOT NULL DEFAULT 0,
    accepted_at timestamptz,
    accepted_by text REFERENCES "user"(id) ON DELETE SET NULL,
    declined_at timestamptz,
    revoked_at timestamptz
  );
  CREATE INDEX kern_invite_space ON kern_invite(space_id);
  CREATE INDEX kern_invite_email ON kern_invite(lower(email));
  CREATE UNIQUE INDEX kern_invite_open ON kern_invite(space_id, lower(email))
    WHERE accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;

  -- One row per synced record. data holds the client's columns (as JSON);
  -- deleted rows stay as tombstones so other devices learn about them.
  CREATE TABLE kern_record (
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    tbl text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    deleted boolean NOT NULL DEFAULT false,
    seq bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    PRIMARY KEY (space_id, tbl, id)
  );
  CREATE INDEX kern_record_seq ON kern_record(space_id, seq);

  -- Workspace activity shown in management (joins, role changes, imports).
  CREATE TABLE kern_audit (
    id bigserial PRIMARY KEY,
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    actor_id text REFERENCES "user"(id) ON DELETE SET NULL,
    action text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX kern_audit_space ON kern_audit(space_id, created_at DESC);
  `,
  // 2: shared whiteboard images. Compressed by the app before upload and
  //    de-duplicated per space by content hash.
  `
  CREATE TABLE kern_asset (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    sha256 text NOT NULL,
    mime text NOT NULL,
    size int NOT NULL,
    width int,
    height int,
    bytes bytea NOT NULL,
    created_by text REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX kern_asset_hash ON kern_asset(space_id, sha256);
  `,
  // 3: streams. Inbound endpoints (<STREAMS_URL>/kern/<id>) that turn
  //    submissions from websites and services into tasks, inbox items and
  //    GitHub issues. Secrets and tokens are stored encrypted (AES-256-GCM);
  //    preferences live in config (validated by the API). Every submission
  //    leaves a delivery log entry, pruned by each stream's retention.
  `
  CREATE TABLE kern_stream (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true,
    config jsonb NOT NULL DEFAULT '{}'::jsonb,
    secret_enc text NOT NULL,
    secret_hint text NOT NULL,
    -- After a rotation the previous secret keeps working until this time.
    previous_secret_enc text,
    previous_expires_at timestamptz,
    github_token_enc text,
    github_token_hint text,
    github_checked_at timestamptz,
    turnstile_secret_enc text,
    created_by text REFERENCES "user"(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_delivery_at timestamptz,
    delivery_count bigint NOT NULL DEFAULT 0
  );
  CREATE INDEX kern_stream_space ON kern_stream(space_id);

  CREATE TABLE kern_stream_event (
    id bigserial PRIMARY KEY,
    stream_id text NOT NULL REFERENCES kern_stream(id) ON DELETE CASCADE,
    received_at timestamptz NOT NULL DEFAULT now(),
    -- delivered | partial | rejected | duplicate | spam | failed
    status text NOT NULL,
    code text,
    message text,
    test boolean NOT NULL DEFAULT false,
    auth text,
    ip_hash text,
    origin text,
    user_agent text,
    content_type text,
    payload jsonb,
    payload_hash text,
    idempotency_key text,
    task_id text,
    inbox_id text,
    issue_number int,
    issue_url text,
    duration_ms int
  );
  CREATE INDEX kern_stream_event_stream ON kern_stream_event(stream_id, received_at DESC);
  CREATE INDEX kern_stream_event_hash ON kern_stream_event(stream_id, payload_hash, received_at DESC) WHERE payload_hash IS NOT NULL;
  CREATE UNIQUE INDEX kern_stream_event_idem ON kern_stream_event(stream_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  `,
  // 4: public share links (read-only snapshots of a note, whiteboard or
  //    project published from the app) and private calendar feeds (an ICS
  //    address per member and space for calendar apps to subscribe to).
  `
  CREATE TABLE kern_share (
    id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{22}$'),
    owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('note', 'whiteboard', 'project')),
    ref_id text NOT NULL,
    title text NOT NULL,
    content jsonb NOT NULL DEFAULT '{}'::jsonb,
    image bytea,
    image_mime text,
    views int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz
  );
  CREATE UNIQUE INDEX kern_share_ref ON kern_share(owner_id, kind, ref_id) WHERE revoked_at IS NULL;
  CREATE INDEX kern_share_owner ON kern_share(owner_id, updated_at DESC);

  CREATE TABLE kern_calendar_feed (
    token text PRIMARY KEY CHECK (token ~ '^[A-Za-z0-9_-]{32,64}$'),
    space_id uuid NOT NULL REFERENCES kern_space(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    options jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_fetched_at timestamptz,
    UNIQUE (space_id, user_id)
  );
  `,
  // 5: self-hosting. Management tokens for Kern Platform and kernctl,
  //    settings an administrator can change without restarting, the sign-up
  //    allow list used by invite-only registration, an account hold that
  //    blocks sign-in without deleting anything, and a record of management
  //    actions.
  `
  CREATE TABLE kern_admin_token (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{16}$'),
    -- SHA-256 of the secret half; the token itself is shown once, at creation.
    secret_hash text NOT NULL,
    name text NOT NULL,
    -- 'full' manages everything; 'read' can only look.
    scope text NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'read')),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    last_used_at timestamptz,
    last_used_ip text,
    expires_at timestamptz,
    revoked_at timestamptz
  );

  CREATE TABLE kern_instance_setting (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE kern_signup_allow (
    email text PRIMARY KEY,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    used_at timestamptz
  );

  CREATE TABLE kern_account_hold (
    user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    reason text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text
  );

  CREATE TABLE kern_admin_audit (
    id bigserial PRIMARY KEY,
    token_id text,
    action text NOT NULL,
    target text,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX kern_admin_audit_time ON kern_admin_audit(created_at DESC);
  `,
  // 7: workspace keys. When WORKSPACE_KEYS is on, creating a workspace needs
  // one of these (`k_<32 hex>`), minted by an administrator and handed to the
  // person who may use this instance. Only the hash is stored, so the table
  // is worthless if it leaks. A key binds to the first account that uses it
  // and is refused to any other, which is what stops one key being passed
  // around. Joining a workspace by invitation never consults this table.
  `
  CREATE TABLE kern_workspace_key (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}$'),
    -- SHA-256 of the whole key; the key itself is shown once, at creation.
    key_hash text NOT NULL UNIQUE,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text,
    -- The account that first used it. NULL until then; never changes after.
    redeemed_by text REFERENCES "user"(id) ON DELETE SET NULL,
    redeemed_at timestamptz,
    last_used_at timestamptz,
    uses int NOT NULL DEFAULT 0,
    revoked_at timestamptz
  );
  CREATE INDEX kern_workspace_key_redeemed ON kern_workspace_key(redeemed_by) WHERE redeemed_by IS NOT NULL;
  CREATE INDEX kern_workspace_key_created ON kern_workspace_key(created_at DESC);
  `,
];

export async function migrate(): Promise<void> {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(authOptions);
  if (toBeCreated.length || toBeAdded.length) {
    console.log(`[migrate] auth: creating ${toBeCreated.map((t) => t.table).join(", ") || "-"}; updating ${toBeAdded.map((t) => t.table).join(", ") || "-"}`);
    await runMigrations();
  }

  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS kern_migration (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    // Only one server instance migrates at a time.
    await client.query("SELECT pg_advisory_lock(727301)");
    const { rows } = await client.query<{ v: number | null }>("SELECT max(version) AS v FROM kern_migration");
    const current = rows[0]?.v ?? 0;
    for (let i = current; i < STEPS.length; i++) {
      const version = i + 1;
      console.log(`[migrate] applying kern step ${version}`);
      await client.query("BEGIN");
      try {
        await client.query(STEPS[i]!);
        await client.query("INSERT INTO kern_migration(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727301)").catch(() => undefined);
    client.release();
  }
}
