import { describe, expect, it } from "vitest";
import { runConcurrencySoak } from "../scripts/soak.js";

describe("multi-process claims", () => {
  it("processes every job once across competing SQLite connections", async () => {
    const result = await runConcurrencySoak({ jobs: 60, workers: 4 });
    expect(result.uniqueCompletions).toBe(60);
    expect(result.duplicateCompletions).toBe(0);
    expect(result.activeWorkers).toBeGreaterThan(1);
  });
});
