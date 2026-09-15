import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/store.js";

interface WorkerResult {
  workerId: string;
  claimedIds: string[];
}

function runClaimProcess(databasePath: string, workerId: string): Promise<WorkerResult> {
  const helperPath = fileURLToPath(new URL("./helpers/claim-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", helperPath, databasePath, workerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Claim process ${workerId} exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as WorkerResult);
    });
  });
}

describe("multi-process claims", () => {
  it("processes every job once across competing SQLite connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "job-concurrency-"));
    const databasePath = join(directory, "jobs.db");
    const initialStore = new JobStore(databasePath);
    const jobs = Array.from({ length: 60 }, (_, index) =>
      initialStore.enqueue("test", { index }),
    );
    initialStore.close();

    try {
      const results = await Promise.all(
        ["worker-a", "worker-b", "worker-c", "worker-d"].map((workerId) =>
          runClaimProcess(databasePath, workerId),
        ),
      );
      const claimedIds = results.flatMap((result) => result.claimedIds);

      expect(claimedIds).toHaveLength(jobs.length);
      expect(new Set(claimedIds).size).toBe(jobs.length);
      expect(results.filter((result) => result.claimedIds.length > 0).length).toBeGreaterThan(1);

      const finalStore = new JobStore(databasePath);
      try {
        for (const job of jobs) {
          expect(finalStore.get(job.id)?.status).toBe("succeeded");
        }
      } finally {
        finalStore.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
