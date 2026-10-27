// PostgreSQL access: one shared pool (also handed to Better Auth) and small
// helpers for queries and transactions.

import pg from "pg";
import { config } from "./config.js";

// BIGINT (sequence numbers) as JS numbers: they stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

// pg parses a connection string lazily, when it first opens a client, and the
// error it throws for a bad one withholds the string (ERR_INVALID_URL, input
// redacted). A malformed DATABASE_URL therefore arrives as a failure on every
// query with nothing in the log to act on. Parsing it here, through pg's own
// parser, turns that into one refusal at startup that names the cause.
if ("connectionString" in config.database) {
  try {
    new pg.Client(config.database);
  } catch {
    throw new Error(
      'DATABASE_URL is set, and PostgreSQL cannot parse it as a connection URL. A "/", "?" or "#" in the password ends the URL\'s authority early and has to be percent-encoded ("/" as %2F). Under docker compose the other fix is to remove the DATABASE_URL line from .env: PGHOST and PGPASSWORD then carry the same details, and a password passed that way needs no escaping (see .env.example).',
    );
  }
}

export const pool = new pg.Pool({
  ...config.database,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (e) => console.error("[db] idle client error", e));

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Runs `fn` in a transaction, rolling back on any error. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
