import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../src/logger.js";
import { JobStore } from "../src/store.js";
import { Worker } from "../src/worker.js";

const stores: JobStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("Worker lifecycle", () => {
  it("renews a lease while a handler is still running", async () => {
    const store = new JobStore(":memory:");
    stores.push(store);
    const job = store.enqueue("controlled", {});
    let releaseHandler: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const canFinish = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const worker = new Worker(store, { controlled: async () => {
      announceStarted?.();
      await canFinish;
      return { done: true };
    } }, { workerId: "long-running", leaseMs: 90, pollIntervalMs: 10 }, silentLogger);

    const running = worker.runOnce();
    await started;
    const originalExpiry = store.get(job.id)!.leaseExpiresAt!;
    await vi.waitFor(() => {
      expect(store.get(job.id)!.leaseExpiresAt).toBeGreaterThan(originalExpiry);
    }, { timeout: 1_000, interval: 10 });
    expect(store.claim("competitor", 90, originalExpiry + 1)).toBeNull();

    releaseHandler?.();
    await running;
    expect(store.get(job.id)).toMatchObject({ status: "succeeded", result: { done: true } });
  });

  it("drains an active handler and does not claim more work after stop", async () => {
    const store = new JobStore(":memory:");
    stores.push(store);
    const first = store.enqueue("controlled", { sequence: 1 });
    let releaseHandler: (() => void) | undefined;
    let announceStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const handlerCanFinish = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = new Worker(store, {
      controlled: async () => {
        announceStarted?.();
        await handlerCanFinish;
        return { done: true };
      },
    }, {
      workerId: "shutdown-worker",
      leaseMs: 1_000,
      pollIntervalMs: 5,
    }, silentLogger);

    worker.start();
    await handlerStarted;
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await delay(10);
    expect(stopped).toBe(false);

    releaseHandler?.();
    await stopping;
    expect(store.get(first.id)).toMatchObject({ status: "succeeded", result: { done: true } });

    const second = store.enqueue("controlled", { sequence: 2 });
    await delay(25);
    expect(store.get(second.id)).toMatchObject({ status: "queued", attempts: 0 });
  });
});
