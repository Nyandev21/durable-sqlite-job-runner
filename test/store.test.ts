import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../src/store.js";

const cleanups: Array<() => void> = [];

function createStore(): JobStore {
  const directory = mkdtempSync(join(tmpdir(), "job-store-"));
  const store = new JobStore(join(directory, "jobs.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("JobStore", () => {
  it("cancels queued jobs without claiming them or interrupting running work", () => {
    const store = createStore();
    const queued = store.enqueue("uppercase", { text: "cancel" });
    const cancelled = store.cancelQueued(queued.id);
    expect(cancelled).toMatchObject({ id: queued.id, status: "cancelled" });
    expect(store.claim("worker", 1_000)).toBeNull();
    expect(store.cancelQueued(queued.id)).toBeNull();

    const running = store.enqueue("uppercase", { text: "keep running" });
    const claim = store.claim("worker", 1_000, running.createdAt)!;
    expect(store.cancelQueued(running.id)).toBeNull();
    expect(store.complete(running.id, "worker", claim.leaseToken, null)).toBe(true);
    expect(store.stats().cancelled).toBe(1);
  });

  it("deduplicates matching requests by idempotency key and rejects conflicting reuse", () => {
    const store = createStore();
    const options = { idempotencyKey: "request-123", priority: 2 };
    const first = store.enqueue("uppercase", { text: "same" }, options);
    const repeated = store.enqueue("uppercase", { text: "same" }, options);
    expect(repeated.id).toBe(first.id);
    expect(store.list({ limit: 10, offset: 0 }).total).toBe(1);
    expect(() => store.enqueue("uppercase", { text: "different" }, options))
      .toThrow("different request");
    expect(store.enqueue("uppercase", { text: "without key" }).id).not.toBe(first.id);
  });

  it("lists a bounded, filtered page with a separate total", () => {
    const store = createStore();
    const first = store.enqueue("uppercase", { order: 1 });
    const second = store.enqueue("uppercase", { order: 2 });
    const third = store.enqueue("uppercase", { order: 3 }, { priority: 10 });
    const claim = store.claim("worker", 1_000, third.createdAt)!;
    store.complete(third.id, "worker", claim.leaseToken, null);

    const page = store.list({ status: "queued", limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.jobs).toHaveLength(1);
    expect([first.id, second.id]).toContain(page.jobs[0]?.id);
    expect(store.list({ status: "succeeded", limit: 10, offset: 0 }).jobs[0]?.id).toBe(third.id);
    expect(store.list({ limit: 10, offset: 0 }).total).toBe(3);
  });

  it("claims ready jobs by priority without letting future jobs block the queue", () => {
    const store = createStore();
    const now = Date.now();
    const normal = store.enqueue("uppercase", { order: "normal" }, { availableAt: now, priority: 0 });
    const urgent = store.enqueue("uppercase", { order: "urgent" }, { availableAt: now, priority: 5 });
    const future = store.enqueue("uppercase", { order: "future" }, { availableAt: now + 1_000, priority: 10 });

    expect(store.claim("worker", 100, now)?.id).toBe(urgent.id);
    expect(store.claim("worker", 100, now)?.id).toBe(normal.id);
    expect(store.claim("worker", 100, now)).toBeNull();
    expect(store.claim("worker", 100, now + 1_000)?.id).toBe(future.id);
  });

  it("reports queue state and currently claimable work", () => {
    const store = createStore();
    const now = Date.now();
    const ready = store.enqueue("uppercase", { text: "ready" }, { availableAt: now });
    store.enqueue("uppercase", { text: "later" }, { availableAt: now + 10_000 });
    const claimed = store.claim("worker-a", 100, now)!;

    expect(store.stats(now + 50)).toEqual({
      total: 2,
      queued: 1,
      running: 1,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      claimable: 0,
      totalAttempts: 1,
    });
    expect(store.stats(now + 101)).toMatchObject({ claimable: 1 });
    expect(store.complete(ready.id, "worker-a", claimed.leaseToken, null, now + 102)).toBe(true);
    expect(store.stats(now + 102)).toMatchObject({ succeeded: 1, running: 0 });
  });

  it("rejects a payload that JSON cannot represent", () => {
    const store = createStore();
    expect(() => store.enqueue("invalid", undefined)).toThrow("JSON-serializable");
  });

  it("claims a queued job exactly once and completes it", () => {
    const store = createStore();
    const created = store.enqueue("uppercase", { text: "durable" });

    const claimed = store.claim("worker-a", 1_000, created.createdAt);
    expect(claimed).toMatchObject({ id: created.id, status: "running", attempts: 1 });
    expect(store.claim("worker-b", 1_000, created.createdAt)).toBeNull();
    expect(store.complete(created.id, "worker-a", claimed!.leaseToken, { text: "DURABLE" })).toBe(true);
    expect(store.get(created.id)).toMatchObject({
      status: "succeeded",
      result: { text: "DURABLE" },
    });
  });

  it("reclaims a job after its lease expires", () => {
    const store = createStore();
    const created = store.enqueue("uppercase", { text: "recover" });
    const original = store.claim("worker-a", 100, created.createdAt)!;

    const reclaimed = store.claim("worker-b", 100, created.createdAt + 101);
    expect(reclaimed).toMatchObject({ id: created.id, workerId: "worker-b", attempts: 2 });
    expect(store.complete(created.id, "worker-a", original.leaseToken, null)).toBe(false);
  });

  it("fences a stale claim even when the worker ID is reused", () => {
    const store = createStore();
    const created = store.enqueue("uppercase", { text: "fenced" });
    const original = store.claim("worker-a", 100, created.createdAt)!;
    const replacement = store.claim("worker-a", 100, created.createdAt + 101)!;

    expect(replacement.leaseToken).not.toBe(original.leaseToken);
    expect(store.heartbeat(created.id, "worker-a", original.leaseToken, 100)).toBe(false);
    expect(store.fail(created.id, "worker-a", original.leaseToken, "stale", 0)).toBe(false);
    expect(store.complete(created.id, "worker-a", original.leaseToken, { stale: true })).toBe(false);
    expect(store.complete(created.id, "worker-a", replacement.leaseToken, { fresh: true })).toBe(true);
    expect(store.get(created.id)).toMatchObject({ status: "succeeded", result: { fresh: true } });
  });

  it("retries with a delay then records a terminal failure", () => {
    const store = createStore();
    const created = store.enqueue("unknown", {}, { maxAttempts: 2 });
    const first = store.claim("worker-a", 100, created.createdAt);
    expect(first).not.toBeNull();
    store.fail(created.id, "worker-a", first!.leaseToken, "first failure", 50, created.createdAt);
    expect(store.claim("worker-a", 100, created.createdAt + 49)).toBeNull();

    const second = store.claim("worker-a", 100, created.createdAt + 50);
    expect(second?.attempts).toBe(2);
    store.fail(created.id, "worker-a", second!.leaseToken, "second failure", 50, created.createdAt + 50);
    expect(store.get(created.id)).toMatchObject({ status: "failed", lastError: "second failure" });
    expect(store.listFailed()).toEqual([
      expect.objectContaining({ id: created.id, status: "failed", lastError: "second failure" }),
    ]);
  });

  it("lists only terminal jobs with a bounded result", () => {
    const store = createStore();
    const first = store.enqueue("unknown", { order: 1 }, { maxAttempts: 1 });
    const second = store.enqueue("unknown", { order: 2 }, { maxAttempts: 1 });
    store.enqueue("uppercase", { text: "still queued" });
    const firstClaim = store.claim("worker-a", 100, first.createdAt)!;
    store.fail(first.id, "worker-a", firstClaim.leaseToken, "failed first", 0, first.createdAt + 1);
    const secondClaim = store.claim("worker-a", 100, second.createdAt + 2)!;
    store.fail(second.id, "worker-a", secondClaim.leaseToken, "failed second", 0, second.createdAt + 3);

    expect(store.listFailed(1)).toEqual([
      expect.objectContaining({ id: second.id, lastError: "failed second" }),
    ]);
  });

  it("requeues only terminal jobs with a fresh attempt budget", () => {
    const store = createStore();
    const failed = store.enqueue("uppercase", { text: "retry" }, { maxAttempts: 1 });
    const queued = store.enqueue("uppercase", { text: "queued" });
    const claim = store.claim("worker-a", 100, failed.createdAt)!;
    store.fail(failed.id, "worker-a", claim.leaseToken, "temporary failure", 0, failed.createdAt + 1);

    expect(store.requeueFailed(failed.id, failed.createdAt + 10)).toMatchObject({
      id: failed.id,
      status: "queued",
      attempts: 0,
      availableAt: failed.createdAt + 10,
      lastError: null,
    });
    expect(store.requeueFailed(queued.id)).toBeNull();
    expect(store.requeueFailed("missing")).toBeNull();
  });
});
