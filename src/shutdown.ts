import type { Server } from "node:http";
import type { Worker } from "./worker.js";

export async function drainForShutdown(server: Server, worker: Worker): Promise<void> {
  // stop() prevents another claim synchronously, then waits for the active handler.
  const workerStopped = worker.stop();
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await Promise.all([workerStopped, serverClosed]);
}
