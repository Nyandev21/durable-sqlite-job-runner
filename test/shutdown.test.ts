import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../src/http.js";
import { silentLogger } from "../src/logger.js";
import { drainForShutdown } from "../src/shutdown.js";
import { JobStore } from "../src/store.js";
import { Worker } from "../src/worker.js";

const stores: JobStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

describe("service shutdown", () => {
  it("stops new claims while an active HTTP request delays server.close", async () => {
    const store = new JobStore(":memory:");
    stores.push(store);
    let announceStarted: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const canFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const processed: string[] = [];
    const worker = new Worker(store, { controlled: async (payload) => {
      const name = (payload as { name: string }).name;
      processed.push(name);
      if (name === "first") {
        announceStarted?.();
        await canFinish;
      }
      return { ok: true };
    } }, { workerId: "shutdown-test", leaseMs: 3_000, pollIntervalMs: 5 }, silentLogger);
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No HTTP port");
    const first = store.enqueue("controlled", { name: "first" });
    worker.start();
    await started;

    const socket = createConnection(address.port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const body = JSON.stringify({ kind: "controlled", payload: { name: "from-http" } });
    const requestSeen = new Promise<void>((resolve) => server.once("request", () => resolve()));
    socket.write(`POST /jobs HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body[0]}`);
    await requestSeen;
    let drained = false;
    const draining = drainForShutdown(server, worker).then(() => { drained = true; });
    const second = store.enqueue("controlled", { name: "second" });
    releaseFirst?.();

    try {
      await vi.waitFor(() => expect(store.get(first.id)?.status).toBe("succeeded"));
      expect(drained).toBe(false);
      expect(processed).toEqual(["first"]);
      expect(store.get(second.id)).toMatchObject({ status: "queued", attempts: 0 });
      const responseReceived = new Promise<string>((resolve) => socket.once("data", (data: Buffer) => resolve(data.toString())));
      socket.write(body.slice(1));
      expect(await responseReceived).toContain("202 Accepted");
    } finally {
      socket.destroy();
      await draining;
    }
    expect(store.list({ limit: 10, offset: 0 }).jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: { name: "from-http" }, status: "queued", attempts: 0 }),
    ]));
  });
});
