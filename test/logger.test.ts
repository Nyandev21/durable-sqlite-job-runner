import { describe, expect, it } from "vitest";
import { JsonLogger } from "../src/logger.js";

describe("JsonLogger", () => {
  it("writes one structured JSON object per event", () => {
    const lines: string[] = [];
    const logger = new JsonLogger(
      (line) => lines.push(line),
      () => new Date("2026-09-15T12:00:00.000Z"),
    );

    logger.info("job.claimed", { jobId: "job-1", workerId: "worker-a" });
    logger.error("job.failed", new Error("handler failed"), { jobId: "job-1" });

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      timestamp: "2026-09-15T12:00:00.000Z",
      level: "info",
      event: "job.claimed",
      jobId: "job-1",
      workerId: "worker-a",
    });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      level: "error",
      event: "job.failed",
      error: { name: "Error", message: "handler failed" },
    });
  });
});
