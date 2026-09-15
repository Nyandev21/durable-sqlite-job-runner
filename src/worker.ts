import type { JobHandler } from "./types.js";
import type { JobStore } from "./store.js";
import { consoleLogger, type Logger } from "./logger.js";

export interface WorkerOptions {
  workerId: string;
  leaseMs: number;
  pollIntervalMs: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export class Worker {
  readonly #store: JobStore;
  readonly #handlers: Readonly<Record<string, JobHandler>>;
  readonly #options: Required<WorkerOptions>;
  readonly #logger: Logger;
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;

  constructor(
    store: JobStore,
    handlers: Readonly<Record<string, JobHandler>>,
    options: WorkerOptions,
    logger: Logger = consoleLogger,
  ) {
    this.#store = store;
    this.#handlers = handlers;
    this.#options = { retryBaseDelayMs: 250, retryMaxDelayMs: 30_000, ...options };
    this.#logger = logger;
  }

  async runOnce(): Promise<boolean> {
    const job = this.#store.claim(this.#options.workerId, this.#options.leaseMs);
    if (job === null) return false;
    this.#logger.info("job.claimed", {
      jobId: job.id,
      kind: job.kind,
      attempt: job.attempts,
      workerId: this.#options.workerId,
    });

    const handler = this.#handlers[job.kind];
    try {
      if (handler === undefined) throw new Error(`No handler registered for job kind: ${job.kind}`);
      const result = await handler(job.payload);
      if (!this.#store.complete(job.id, this.#options.workerId, result)) {
        throw new Error(`Worker lost ownership of job ${job.id}`);
      }
      this.#logger.info("job.succeeded", { jobId: job.id, workerId: this.#options.workerId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const delay = Math.min(
        this.#options.retryMaxDelayMs,
        this.#options.retryBaseDelayMs * 2 ** (job.attempts - 1),
      );
      this.#store.fail(job.id, this.#options.workerId, message, delay);
      this.#logger.error("job.failed_attempt", error, {
        jobId: job.id,
        workerId: this.#options.workerId,
        retryDelayMs: delay,
      });
    }
    return true;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const tick = async (): Promise<void> => {
      if (this.#stopped) return;
      try {
        const worked = await this.runOnce();
        this.#timer = setTimeout(tick, worked ? 0 : this.#options.pollIntervalMs);
      } catch (error) {
        this.#logger.error("worker.loop.error", error, { workerId: this.#options.workerId });
        this.#timer = setTimeout(tick, this.#options.pollIntervalMs);
      }
    };
    void tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
