import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handlers } from "../src/handlers.js";
import { createHttpServer } from "../src/http.js";
import { JobStore } from "../src/store.js";
import { Worker } from "../src/worker.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("HTTP job flow", () => {
  it("separates process liveness from SQLite readiness", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store);
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
    const server = createHttpServer(store);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.close();
      store.close();
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const accepted = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "checksum", payload: { value: "abc" } }),
    });
    expect(accepted.status).toBe(202);
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
  });
});
