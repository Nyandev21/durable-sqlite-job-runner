import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHttpServer } from "../src/http.js";
import { silentLogger } from "../src/logger.js";
import { JobStore } from "../src/store.js";

const script = fileURLToPath(new URL("../scripts/healthcheck.mjs", import.meta.url));

function probe(port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PORT: String(port) },
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

describe("container healthcheck", () => {
  it("succeeds only while the SQLite readiness endpoint is healthy", async () => {
    const store = new JobStore(":memory:");
    const server = createHttpServer(store, silentLogger);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      expect(await probe(port)).toBe(0);
      store.close();
      expect(await probe(port)).toBe(1);
    } finally {
      server.close();
    }
  });
});
