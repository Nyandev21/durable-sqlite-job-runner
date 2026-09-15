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
  it("reports queue state and currently claimable work", () => {
    const store = createStore();
    const now = Date.now();
    const ready = store.enqueue("uppercase", { text: "ready" }, { availableAt: now });
    store.enqueue("uppercase", { text: "later" }, { availableAt: now + 10_000 });
    store.claim("worker-a", 100, now);

    expect(store.stats(now + 50)).toEqual({
      total: 2,
      queued: 1,
      running: 1,
      succeeded: 0,
      failed: 0,
      claimable: 0,
      totalAttempts: 1,
    });
    expect(store.stats(now + 101)).toMatchObject({ claimable: 1 });
    expect(store.complete(ready.id, "worker-a", null, now + 102)).toBe(true);
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
    expect(store.complete(created.id, "worker-a", { text: "DURABLE" })).toBe(true);
    expect(store.get(created.id)).toMatchObject({
      status: "succeeded",
      result: { text: "DURABLE" },
    });
  });

  it("reclaims a job after its lease expires", () => {
    const store = createStore();
    const created = store.enqueue("uppercase", { text: "recover" });
    store.claim("worker-a", 100, created.createdAt);

    const reclaimed = store.claim("worker-b", 100, created.createdAt + 101);
    expect(reclaimed).toMatchObject({ id: created.id, workerId: "worker-b", attempts: 2 });
    expect(store.complete(created.id, "worker-a", null)).toBe(false);
  });

  it("retries with a delay then records a terminal failure", () => {
    const store = createStore();
    const created = store.enqueue("unknown", {}, { maxAttempts: 2 });
    const first = store.claim("worker-a", 100, created.createdAt);
    expect(first).not.toBeNull();
    store.fail(created.id, "worker-a", "first failure", 50, created.createdAt);
    expect(store.claim("worker-a", 100, created.createdAt + 49)).toBeNull();

    const second = store.claim("worker-a", 100, created.createdAt + 50);
    expect(second?.attempts).toBe(2);
    store.fail(created.id, "worker-a", "second failure", 50, created.createdAt + 50);
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
    store.claim("worker-a", 100, first.createdAt);
    store.fail(first.id, "worker-a", "failed first", 0, first.createdAt + 1);
    store.claim("worker-a", 100, second.createdAt + 2);
    store.fail(second.id, "worker-a", "failed second", 0, second.createdAt + 3);

    expect(store.listFailed(1)).toEqual([
      expect.objectContaining({ id: second.id, lastError: "failed second" }),
    ]);
  });

  it("requeues only terminal jobs with a fresh attempt budget", () => {
    const store = createStore();
    const failed = store.enqueue("uppercase", { text: "retry" }, { maxAttempts: 1 });
    const queued = store.enqueue("uppercase", { text: "queued" });
    store.claim("worker-a", 100, failed.createdAt);
    store.fail(failed.id, "worker-a", "temporary failure", 0, failed.createdAt + 1);

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
