export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job<TPayload = unknown, TResult = unknown> {
  id: string;
  kind: string;
  payload: TPayload;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leaseExpiresAt: number | null;
  workerId: string | null;
  result: TResult | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

// A claim token is private to the worker and must not appear in HTTP job responses.
export interface ClaimedJob extends Job {
  leaseToken: string;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  availableAt?: number;
  priority?: number;
}

export interface QueueStats {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  claimable: number;
  totalAttempts: number;
}

export type JobHandler = (payload: unknown) => unknown | Promise<unknown>;
