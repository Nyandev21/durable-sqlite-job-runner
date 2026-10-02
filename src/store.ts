import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";
import { migrateDatabase } from "./migrations.js";
import type { ClaimedJob, EnqueueOptions, Job, JobAttempt, JobStatus, QueueStats } from "./types.js";

interface JobRow {
  id: string;
  kind: string;
  payload: string;
  priority: number;
  idempotency_fingerprint: string | null;
  status: Job["status"];
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_expires_at: number | null;
  lease_token: string | null;
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
    priority: row.priority,
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

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different request");
  }
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
    `);
    try {
      migrateDatabase(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  enqueue(kind: string, payload: unknown, options: EnqueueOptions = {}): Job {
    const now = Date.now();
    const serializedPayload = JSON.stringify(payload);
    if (serializedPayload === undefined) {
      throw new TypeError("Job payload must be JSON-serializable");
    }
    const fingerprint = JSON.stringify({
      kind, payload, maxAttempts: options.maxAttempts ?? 3,
      availableAt: options.availableAt ?? null, priority: options.priority ?? 0,
    });
    const transactional = options.idempotencyKey !== undefined;
    if (transactional) this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (options.idempotencyKey !== undefined) {
        const existing = this.#database.prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
          .get(options.idempotencyKey) as JobRow | undefined;
        if (existing !== undefined) {
          if (existing.idempotency_fingerprint !== fingerprint) throw new IdempotencyConflictError();
          const job = deserialize(existing);
          this.#database.exec("COMMIT");
          return job;
        }
      }
      const job: Job = {
        id: randomUUID(),
        kind,
        payload,
        priority: options.priority ?? 0,
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
          id, kind, payload, priority, status, attempts, max_attempts, available_at,
          lease_expires_at, worker_id, result, last_error, created_at, updated_at,
          idempotency_key, idempotency_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.kind,
        serializedPayload,
        job.priority,
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
        options.idempotencyKey ?? null,
        options.idempotencyKey === undefined ? null : fingerprint,
      );
      if (transactional) this.#database.exec("COMMIT");
      return job;
    } catch (error) {
      if (transactional) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): Job | null {
    const row = this.#database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row === undefined ? null : deserialize(row);
  }

  list(options: { status?: JobStatus | undefined; limit: number; offset: number }): { total: number; jobs: Job[] } {
    const where = options.status === undefined ? "" : "WHERE status = ?";
    const filter = options.status === undefined ? [] : [options.status];
    const total = this.#database.prepare(`SELECT count(*) AS count FROM jobs ${where}`)
      .get(...filter) as { count: number };
    const rows = this.#database.prepare(`
      SELECT * FROM jobs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...filter, options.limit, options.offset) as unknown as JobRow[];
    return { total: total.count, jobs: rows.map(deserialize) };
  }

  cancelQueued(id: string, now = Date.now()): Job | null {
    const updated = this.#database.prepare(`
      UPDATE jobs SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(now, id);
    return this.#changed(updated) ? this.get(id) : null;
  }

  listAttempts(id: string, limit = 50): JobAttempt[] {
    const rows = this.#database.prepare(`
      SELECT attempt_number, worker_id, started_at, finished_at, outcome, error
      FROM job_attempts WHERE job_id = ? ORDER BY id DESC LIMIT ?
    `).all(id, limit) as Array<{
      attempt_number: number; worker_id: string; started_at: number;
      finished_at: number | null; outcome: JobAttempt["outcome"]; error: string | null;
    }>;
    return rows.map((row) => ({
      attemptNumber: row.attempt_number, workerId: row.worker_id,
      startedAt: row.started_at, finishedAt: row.finished_at,
      outcome: row.outcome, error: row.error,
    }));
  }

  listFailed(limit = 50): Job[] {
    const rows = this.#database.prepare(`
      SELECT * FROM jobs
      WHERE status = 'failed'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(limit) as unknown as JobRow[];
    return rows.map(deserialize);
  }

  requeueFailed(id: string, now = Date.now()): Job | null {
    const updated = this.#database.prepare(`
      UPDATE jobs
      SET status = 'queued', attempts = 0, available_at = ?,
          worker_id = NULL, lease_expires_at = NULL, result = NULL,
          last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(now, now, id);
    return this.#changed(updated) ? this.get(id) : null;
  }

  isReady(): boolean {
    try {
      const row = this.#database.prepare(`
        SELECT count(*) AS count FROM sqlite_schema
        WHERE type = 'table' AND name = 'jobs'
      `).get() as { count: number };
      return row.count === 1;
    } catch {
      return false;
    }
  }

  stats(now = Date.now()): QueueStats {
    return this.#database.prepare(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE status = 'queued') AS queued,
        count(*) FILTER (WHERE status = 'running') AS running,
        count(*) FILTER (WHERE status = 'succeeded') AS succeeded,
        count(*) FILTER (WHERE status = 'failed') AS failed,
        count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE
          attempts < max_attempts AND (
            (status = 'queued' AND available_at <= ?)
            OR (status = 'running' AND lease_expires_at <= ?)
          )
        ) AS claimable,
        coalesce(sum(attempts), 0) AS totalAttempts
      FROM jobs
    `).get(now, now) as unknown as QueueStats;
  }

  claim(workerId: string, leaseMs: number, now = Date.now()): ClaimedJob | null {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      // Exhausted leases cannot be reclaimed; move them to the dead-letter set
      // so a crash on the final attempt cannot leave a job running forever.
      this.#database.prepare(`
        UPDATE job_attempts SET outcome = 'expired', finished_at = ?
        WHERE outcome = 'running' AND lease_token IN (
          SELECT lease_token FROM jobs
          WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts
        )
      `).run(now, now);
      this.#database.prepare(`
        UPDATE jobs SET status = 'failed', worker_id = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_error = 'Lease expired after final attempt', updated_at = ?
        WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts
      `).run(now, now);
      const row = this.#database.prepare(`
        SELECT * FROM jobs
        WHERE attempts < max_attempts
          AND (
            (status = 'queued' AND available_at <= ?)
            OR (status = 'running' AND lease_expires_at <= ?)
          )
        ORDER BY priority DESC, available_at ASC, created_at ASC
        LIMIT 1
      `).get(now, now) as JobRow | undefined;

      if (row === undefined) {
        this.#database.exec("COMMIT");
        return null;
      }

      const leaseToken = randomUUID();
      if (row.status === "running") {
        this.#database.prepare(`
          UPDATE job_attempts SET outcome = 'expired', finished_at = ?
          WHERE job_id = ? AND lease_token = ? AND outcome = 'running'
        `).run(now, row.id, row.lease_token);
      }
      this.#database.prepare(`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            worker_id = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(workerId, leaseToken, now + leaseMs, now, row.id);
      this.#database.prepare(`
        INSERT INTO job_attempts (job_id, attempt_number, worker_id, lease_token, started_at, outcome)
        VALUES (?, ?, ?, ?, ?, 'running')
      `).run(row.id, row.attempts + 1, workerId, leaseToken, now);
      this.#database.exec("COMMIT");
      return { ...this.get(row.id)!, leaseToken };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(id: string, workerId: string, leaseToken: string, leaseMs: number, now = Date.now()): boolean {
    const result = this.#database.prepare(`
      UPDATE jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_token = ?
    `).run(now + leaseMs, now, id, workerId, leaseToken);
    return this.#changed(result);
  }

  complete(id: string, workerId: string, leaseToken: string, result: unknown, now = Date.now()): boolean {
    const serializedResult = JSON.stringify(result ?? null);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.#database.prepare(`
      UPDATE jobs
      SET status = 'succeeded', result = ?, worker_id = NULL, lease_token = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_token = ?
      `).run(serializedResult, now, id, workerId, leaseToken);
      if (this.#changed(updated)) {
        this.#database.prepare(`
          UPDATE job_attempts SET outcome = 'succeeded', finished_at = ?
          WHERE job_id = ? AND lease_token = ? AND outcome = 'running'
        `).run(now, id, leaseToken);
      }
      this.#database.exec("COMMIT");
      return this.#changed(updated);
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  fail(id: string, workerId: string, leaseToken: string, error: string, retryDelayMs: number, now = Date.now()): boolean {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.#database.prepare(`
      UPDATE jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
          available_at = CASE WHEN attempts >= max_attempts THEN available_at ELSE ? END,
          last_error = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_token = ?
      `).run(now + retryDelayMs, error, now, id, workerId, leaseToken);
      if (this.#changed(updated)) {
        this.#database.prepare(`
          UPDATE job_attempts SET outcome = 'failed', finished_at = ?, error = ?
          WHERE job_id = ? AND lease_token = ? AND outcome = 'running'
        `).run(now, error, id, leaseToken);
      }
      this.#database.exec("COMMIT");
      return this.#changed(updated);
    } catch (caught) {
      this.#database.exec("ROLLBACK");
      throw caught;
    }
  }

  close(): void {
    this.#database.close();
  }

  #changed(result: StatementResultingChanges): boolean {
    return result.changes === 1;
  }
}
