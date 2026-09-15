import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import type { EnqueueOptions, Job } from "./types.js";

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  status: Job["status"];
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_expires_at: number | null;
  worker_id: string | null;
  result: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function deserialize(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    workerId: row.worker_id,
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
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
    `);
  }

  enqueue(kind: string, payload: unknown, options: EnqueueOptions = {}): Job {
    const now = Date.now();
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) {
      throw new TypeError("Job payload must be JSON-serializable");
    }
    const job: Job = {
      id: randomUUID(),
      kind,
      payload,
      status: "queued",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      availableAt: options.availableAt ?? now,
      leaseExpiresAt: null,
      workerId: null,
      result: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#database.prepare(`
      INSERT INTO jobs (
        id, kind, payload, status, attempts, max_attempts, available_at,
        lease_expires_at, worker_id, result, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.kind,
      serializedPayload,
      job.status,
      job.attempts,
      job.maxAttempts,
      job.availableAt,
      null,
      null,
      null,
      null,
      job.createdAt,
      job.updatedAt,
    );
    return job;
  }

  get(id: string): Job | null {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row === undefined ? null : deserialize(row);
  }

  claim(workerId: string, leaseMs: number, now = Date.now()): Job | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#database.prepare(`
        SELECT * FROM jobs
        WHERE attempts < max_attempts
          AND (
            (status = 'queued' AND available_at <= ?)
            OR (status = 'running' AND lease_expires_at <= ?)
          )
        ORDER BY available_at ASC, created_at ASC
        LIMIT 1
      `).get(now, now) as JobRow | undefined;

      if (row === undefined) {
        this.#database.exec("COMMIT");
        return null;
      }

      this.#database.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            worker_id = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(workerId, now + leaseMs, now, row.id);
      this.#database.exec("COMMIT");
      return this.get(row.id);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(id: string, workerId: string, leaseMs: number, now = Date.now()): boolean {
    const result = this.#database.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(now + leaseMs, now, id, workerId);
    return this.#changed(result);
  }

  complete(id: string, workerId: string, result: unknown, now = Date.now()): boolean {
    const updated = this.#database.prepare(`
      UPDATE jobs
      SET status = 'succeeded', result = ?, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(JSON.stringify(result ?? null), now, id, workerId);
    return this.#changed(updated);
  }

  fail(id: string, workerId: string, error: string, retryDelayMs: number, now = Date.now()): boolean {
    const updated = this.#database.prepare(`
      UPDATE jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
          last_error = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ?
    `).run(now + retryDelayMs, error, now, id, workerId);
    return this.#changed(updated);
  }

  close(): void {
    this.#database.close();
  }

  #changed(result: StatementResultingChanges): boolean {
    return result.changes === 1;
  }
}
