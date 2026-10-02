import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrateDatabase } from "../src/migrations.js";
import { JobStore } from "../src/store.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "job-migrations-"));
  directories.push(directory);
  return join(directory, "jobs.db");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("database migrations", () => {
  it("upgrades a legacy unversioned database without losing jobs", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        available_at INTEGER NOT NULL, lease_expires_at INTEGER, worker_id TEXT,
        result TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    legacy.prepare(`
      INSERT INTO jobs (
        id, kind, payload, status, attempts, max_attempts, available_at,
        created_at, updated_at
      ) VALUES ('legacy-job', 'uppercase', '{}', 'queued', 0, 3, 0, 0, 0)
    `).run();
    legacy.close();

    const store = new JobStore(path);
    expect(store.get("legacy-job")).toMatchObject({ id: "legacy-job", status: "queued" });
    store.close();

    const reopened = new DatabaseSync(path);
    const version = reopened.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(LATEST_SCHEMA_VERSION);
    expect(migrateDatabase(reopened)).toBe(LATEST_SCHEMA_VERSION);
    reopened.close();
  });

  it("rejects a database created by a newer incompatible service", () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    database.close();

    expect(() => new JobStore(path)).toThrow("newer than supported");
  });
});
