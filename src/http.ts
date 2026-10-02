import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { consoleLogger, type Logger } from "./logger.js";
import type { JobStore } from "./store.js";

const enqueueRequest = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  runAt: z.iso.datetime({ offset: true }).optional(),
  priority: z.number().int().min(-10).max(10).default(0),
});

const deadLetterQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const listJobsQuery = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

class ClientRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1_000_000) throw new ClientRequestError(413, "Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ClientRequestError(400, "Invalid JSON body");
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function requestId(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  return typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128
    ? supplied
    : randomUUID();
}

export function createHttpServer(store: JobStore, logger: Logger = consoleLogger): Server {
  return createServer(async (request, response) => {
    const correlationId = requestId(request);
    const startedAt = performance.now();
    response.setHeader("x-request-id", correlationId);
    response.once("finish", () => {
      logger.info("http.request.completed", {
        requestId: correlationId,
        method: request.method,
        path: request.url,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    });
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const ready = store.isReady();
        json(response, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/stats") {
        json(response, 200, store.stats());
        return;
      }

      if (request.method === "GET" && url.pathname === "/jobs") {
        const query = listJobsQuery.parse(Object.fromEntries(url.searchParams));
        json(response, 200, store.list(query));
        return;
      }

      if (request.method === "POST" && url.pathname === "/jobs") {
        const input = enqueueRequest.parse(await readJson(request));
        const job = store.enqueue(input.kind, input.payload, {
          priority: input.priority,
          ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
          ...(input.runAt === undefined ? {} : { availableAt: Date.parse(input.runAt) }),
        });
        logger.info("job.enqueued", { requestId: correlationId, jobId: job.id, kind: job.kind });
        json(response, 202, job);
        return;
      }

      if (request.method === "GET" && url.pathname === "/dead-letter") {
        const query = deadLetterQuery.parse(Object.fromEntries(url.searchParams));
        const jobs = store.listFailed(query.limit);
        json(response, 200, { count: jobs.length, jobs });
        return;
      }

      const match = /^\/jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && match?.[1] !== undefined) {
        const job = store.get(decodeURIComponent(match[1]));
        json(response, job === null ? 404 : 200, job ?? { error: "Job not found" });
        return;
      }

      const retryMatch = /^\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retryMatch?.[1] !== undefined) {
        const id = decodeURIComponent(retryMatch[1]);
        const existing = store.get(id);
        if (existing === null) {
          json(response, 404, { error: "Job not found" });
          return;
        }
        if (existing.status !== "failed") {
          json(response, 409, { error: `Only failed jobs can be retried; current status is ${existing.status}` });
          return;
        }
        const job = store.requeueFailed(id);
        logger.info("job.requeued", { requestId: correlationId, jobId: id });
        json(response, 202, job);
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        json(response, 400, { error: "Invalid request", issues: error.issues });
        return;
      }
      logger.error("http.request.rejected", error, { requestId: correlationId });
      if (error instanceof ClientRequestError) {
        json(response, error.status, { error: error.message });
      } else {
        json(response, 500, { error: "Internal server error" });
      }
    }
  });
}
