import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "../src/store.js";

interface WorkerResult { workerId: string; claimedIds: string[] }
export interface SoakOptions { jobs: number; workers: number }
export interface SoakResult extends SoakOptions {
  uniqueCompletions: number;
  duplicateCompletions: number;
  activeWorkers: number;
  durationMs: number;
}

function runWorker(databasePath: string, workerId: string): Promise<WorkerResult> {
  const workerPath = fileURLToPath(new URL("./claim-worker.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, databasePath, workerId], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Claim process ${workerId} exited ${String(code)}: ${stderr}`));
      resolve(JSON.parse(stdout) as WorkerResult);
    });
  });
}

export async function runConcurrencySoak(options: SoakOptions): Promise<SoakResult> {
  if (!Number.isInteger(options.jobs) || options.jobs < 1) throw new Error("jobs must be a positive integer");
  if (!Number.isInteger(options.workers) || options.workers < 2) throw new Error("workers must be an integer of at least 2");
  const startedAt = performance.now();
  const directory = mkdtempSync(join(tmpdir(), "job-soak-"));
  const databasePath = join(directory, "jobs.db");
  const initialStore = new JobStore(databasePath);
  const jobs = Array.from({ length: options.jobs }, (_, index) => initialStore.enqueue("soak", { index }));
  initialStore.close();
  try {
    const results = await Promise.all(Array.from({ length: options.workers }, (_, index) => runWorker(databasePath, `worker-${index + 1}`)));
    const completedIds = results.flatMap((result) => result.claimedIds);
    const uniqueIds = new Set(completedIds);
    const finalStore = new JobStore(databasePath);
    try {
      const missing = jobs.filter((job) => finalStore.get(job.id)?.status !== "succeeded");
      if (missing.length > 0) throw new Error(`${missing.length} jobs did not reach succeeded`);
    } finally {
      finalStore.close();
    }
    if (completedIds.length !== jobs.length || uniqueIds.size !== jobs.length) {
      throw new Error(`Expected ${jobs.length} unique completions; observed ${completedIds.length} total and ${uniqueIds.size} unique`);
    }
    return { ...options, uniqueCompletions: uniqueIds.size, duplicateCompletions: completedIds.length - uniqueIds.size, activeWorkers: results.filter((result) => result.claimedIds.length > 0).length, durationMs: Math.round(performance.now() - startedAt) };
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
