import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/store.js";

const script = fileURLToPath(new URL("../scripts/check-db.mjs", import.meta.url));

function check(path: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, path], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

describe("SQLite integrity command", () => {
  it("accepts a live WAL database and rejects missing or corrupt files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "job-integrity-"));
    const healthyPath = join(directory, "healthy.db");
    const corruptPath = join(directory, "corrupt.db");
    const store = new JobStore(healthyPath);
    try {
      store.enqueue("uppercase", { text: "durable" });
      expect(await check(healthyPath)).toBe(0);
      expect(await check(join(directory, "missing.db"))).toBe(1);
      writeFileSync(corruptPath, "not a sqlite database");
      expect(await check(corruptPath)).toBe(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
