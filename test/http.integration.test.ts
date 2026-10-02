import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handlers } from "../src/handlers.js";
import { createHttpServer } from "../src/http.js";
import { silentLogger, type LogContext, type Logger } from "../src/logger.js";
import { JobStore } from "../src/store.js";
import { Worker } from "../src/worker.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("HTTP job flow", () => {
  it("protects job routes with an optional bearer token while leaving probes public", async () => {
    const store = new JobStore(":memory:");
    const token = "this-is-a-long-random-secret";
    const server = createHttpServer(store, silentLogger, token);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { server.close(); store.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/ready`)).status).toBe(200);
    const missing = await fetch(`${base}/jobs`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");
    expect((await fetch(`${base}/stats`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/stats`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it("returns the original job for a repeated idempotent enqueue", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { server.close(); store.close(); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jobs`;
    const post = (text: string) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "uppercase", payload: { text }, idempotencyKey: "client-request-1" }),
    });

    const first = await post("same");
    const repeated = await post("same");
    expect(first.status).toBe(202);
    expect(repeated.status).toBe(202);
    expect((await first.json() as { id: string }).id).toBe((await repeated.json() as { id: string }).id);
    expect((await post("different")).status).toBe(409);
    expect(store.list({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it("lists filtered job pages and validates pagination parameters", async () => {
    const store = new JobStore(":memory:");
    store.enqueue("uppercase", { order: 1 });
    store.enqueue("uppercase", { order: 2 });
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { server.close(); store.close(); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jobs`;

    const page = await fetch(`${base}?status=queued&limit=1&offset=1`);
    expect(page.status).toBe(200);
    await expect(page.json()).resolves.toMatchObject({ total: 2, jobs: [expect.objectContaining({ status: "queued" })] });
    expect((await fetch(`${base}?limit=101`)).status).toBe(400);
    expect((await fetch(`${base}?status=invalid`)).status).toBe(400);
  });

  it("accepts a scheduled run time without claiming the job early", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.close();
      store.close();
    });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/jobs`;
    const scheduledFor = Date.now() + 60_000;
    const created = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "uppercase", payload: { text: "later" }, runAt: new Date(scheduledFor).toISOString() }),
    });
    expect(created.status).toBe(202);
    const job = (await created.json()) as { id: string; availableAt: number };
    expect(job.availableAt).toBe(scheduledFor);
    expect(store.claim("early-worker", 1_000, scheduledFor - 1)).toBeNull();
    expect(store.claim("scheduled-worker", 1_000, scheduledFor)?.id).toBe(job.id);

    const invalid = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "uppercase", payload: {}, runAt: "next Tuesday" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("accepts bounded priority and rejects out-of-range values", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => { server.close(); store.close(); });
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/jobs`;
    const post = (priority: number) => fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "uppercase", payload: { text: "priority" }, priority }),
    });
    const accepted = await post(7);
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ priority: 7 });
    expect((await post(11)).status).toBe(400);
  });


  it("distinguishes malformed input from internal storage failures", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/jobs`;

    const invalid = await fetch(url, { method: "POST", body: "{not-json" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "Invalid JSON body" });

    const oversized = await fetch(url, { method: "POST", body: " ".repeat(1_000_001) });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "Request body exceeds 1 MB" });

    store.close();
    const unavailable = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(unavailable.status).toBe(500);
    await expect(unavailable.json()).resolves.toEqual({ error: "Internal server error" });
  });

  it("separates process liveness from SQLite readiness", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await expect(fetch(`${baseUrl}/health`).then((response) => response.json())).resolves.toEqual({
      status: "ok",
    });
    const ready = await fetch(`${baseUrl}/ready`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ready" });

    store.close();
    const unavailable = await fetch(`${baseUrl}/ready`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ status: "not_ready" });
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("accepts, processes, and returns a persisted job", async () => {
    const store = new JobStore(":memory:");
    const events: Array<{ event: string; context?: LogContext }> = [];
    const logger: Logger = {
      info(event, context) { events.push({ event, ...(context === undefined ? {} : { context }) }); },
      error() {},
    };
    const server = createHttpServer(store, logger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.close();
      store.close();
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const accepted = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      // A caller-supplied ID is echoed and included in structured logs.
      headers: { "content-type": "application/json", "x-request-id": "request-test-1" },
      body: JSON.stringify({ kind: "checksum", payload: { value: "abc" } }),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("x-request-id")).toBe("request-test-1");
    const created = (await accepted.json()) as { id: string };

    const worker = new Worker(store, handlers, {
      workerId: "integration-worker",
      leaseMs: 1_000,
      pollIntervalMs: 10,
    });
    expect(await worker.runOnce()).toBe(true);

    const response = await fetch(`${baseUrl}/jobs/${created.id}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: created.id,
      status: "succeeded",
      attempts: 1,
      result: { sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "job.enqueued",
      context: expect.objectContaining({ requestId: "request-test-1", jobId: created.id }),
    }));
  });

  it("exposes terminal jobs through a bounded dead-letter endpoint", async () => {
    const store = new JobStore(":memory:");
    const failed = store.enqueue("unknown", {}, { maxAttempts: 1 });
    const claimed = store.claim("worker-test", 1_000, failed.createdAt)!;
    store.fail(failed.id, "worker-test", claimed.leaseToken, "No handler", 0, failed.createdAt + 1);
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.close();
      store.close();
    });
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/dead-letter?limit=10`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      count: 1,
      jobs: [{ id: failed.id, status: "failed", lastError: "No handler" }],
    });
    expect((await fetch(`http://127.0.0.1:${port}/dead-letter?limit=1000`)).status).toBe(400);

    const retried = await fetch(`http://127.0.0.1:${port}/jobs/${failed.id}/retry`, { method: "POST" });
    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toMatchObject({
      id: failed.id,
      status: "queued",
      attempts: 0,
      lastError: null,
    });
    expect((await fetch(`http://127.0.0.1:${port}/jobs/${failed.id}/retry`, { method: "POST" })).status).toBe(409);
    expect((await fetch(`http://127.0.0.1:${port}/jobs/missing/retry`, { method: "POST" })).status).toBe(404);
  });

  it("exposes an operational queue snapshot", async () => {
    const store = new JobStore(":memory:");
    store.enqueue("uppercase", { text: "observe" });
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.close();
      store.close();
    });
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/stats`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      total: 1,
      queued: 1,
      running: 0,
      succeeded: 0,
      failed: 0,
      claimable: 1,
      totalAttempts: 0,
    });
  });
});
