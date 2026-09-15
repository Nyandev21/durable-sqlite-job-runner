import { setTimeout as delay } from "node:timers/promises";
import { JobStore } from "../../src/store.js";

const [databasePath, workerId] = process.argv.slice(2);
if (databasePath === undefined || workerId === undefined) {
  throw new Error("Usage: claim-worker.ts DATABASE_PATH WORKER_ID");
}

const store = new JobStore(databasePath);
const claimedIds: string[] = [];
try {
  while (true) {
    const job = store.claim(workerId, 5_000);
    if (job === null) break;
    claimedIds.push(job.id);
    if (!store.complete(job.id, workerId, { processedBy: workerId })) {
      throw new Error(`Failed to complete claimed job ${job.id}`);
    }
    await delay(1);
  }
} finally {
  store.close();
}

process.stdout.write(JSON.stringify({ workerId, claimedIds }));
