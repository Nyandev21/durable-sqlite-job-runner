import type { DatabaseSync } from "node:sqlite";

export const LATEST_SCHEMA_VERSION = 2;

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
      available_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      worker_id TEXT,
      result TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_claimable
      ON jobs(status, available_at, lease_expires_at, created_at);
  `,
  `
    CREATE INDEX IF NOT EXISTS jobs_failed_updated
      ON jobs(updated_at DESC, created_at DESC)
      WHERE status = 'failed';
  `,
] as const;

export function migrateDatabase(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  if (row.user_version > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${row.user_version} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let version = row.user_version + 1; version <= LATEST_SCHEMA_VERSION; version += 1) {
      const migration = migrations[version - 1];
      if (migration === undefined) throw new Error(`Missing database migration ${version}`);
      database.exec(migration);
      database.exec(`PRAGMA user_version = ${version}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return LATEST_SCHEMA_VERSION;
}
