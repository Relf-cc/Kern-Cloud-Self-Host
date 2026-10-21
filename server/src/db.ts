// PostgreSQL access: one shared pool (also handed to Better Auth) and small
// helpers for queries and transactions.

import pg from "pg";
import { config } from "./config.js";

// BIGINT (sequence numbers) as JS numbers: they stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

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
