import { loadConfig } from "./config.js";
import { handlers } from "./handlers.js";
import { createHttpServer } from "./http.js";
import { JobStore } from "./store.js";
import { Worker } from "./worker.js";

const config = loadConfig();
const store = new JobStore(config.DB_PATH);
const worker = new Worker(store, handlers, {
  workerId: config.WORKER_ID,
  leaseMs: config.LEASE_MS,
  pollIntervalMs: config.POLL_INTERVAL_MS,
  retryBaseDelayMs: config.RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: config.RETRY_MAX_DELAY_MS,
});
const server = createHttpServer(store);

server.listen(config.PORT, "0.0.0.0", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.PORT;
  console.log(`Job runner listening on port ${port} as ${config.WORKER_ID}`);
  worker.start();
});

function shutdown(): void {
  worker.stop();
  server.close(() => {
    store.close();
    process.exitCode = 0;
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
