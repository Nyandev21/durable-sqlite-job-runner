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
  });
});
