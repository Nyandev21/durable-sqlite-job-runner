import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { JobStore } from "./store.js";

const enqueueRequest = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
});

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function createHttpServer(store: JobStore): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        const input = enqueueRequest.parse(await readJson(request));
        const job = store.enqueue(
          input.kind,
          input.payload,
          input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts },
        );
        json(response, 202, job);
        return;
      }

      const match = /^\/jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && match?.[1] !== undefined) {
        const job = store.get(decodeURIComponent(match[1]));
        json(response, job === null ? 404 : 200, job ?? { error: "Job not found" });
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        json(response, 400, { error: "Invalid request", issues: error.issues });
        return;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      json(response, 400, { error: message });
    }
  });
}
