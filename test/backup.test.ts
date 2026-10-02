import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/store.js";

const script = fileURLToPath(new URL("../scripts/backup.mjs", import.meta.url));

function runBackup(source: string, target: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, source, target], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

describe("online SQLite backup", () => {
  it("copies live WAL data and refuses to overwrite an existing backup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "job-backup-"));
    const source = join(directory, "live.db");
    const target = join(directory, "backup.db");
    const live = new JobStore(source);
    try {
      const job = live.enqueue("uppercase", { text: "persisted" });
      expect(await runBackup(source, target)).toBe(0);
      const restored = new JobStore(target);
      try {
        expect(restored.get(job.id)).toMatchObject({ payload: { text: "persisted" } });
      } finally {
        restored.close();
      }
      live.enqueue("uppercase", { text: "newer" });
      expect(await runBackup(source, target)).toBe(1);
      const unchanged = new JobStore(target);
      try {
        expect(unchanged.list({ limit: 10, offset: 0 }).total).toBe(1);
      } finally {
        unchanged.close();
      }
    } finally {
      live.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
