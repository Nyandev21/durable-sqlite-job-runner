import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("provides production-safe defaults", () => {
    expect(loadConfig({})).toEqual({
      PORT: 3000,
      DB_PATH: "./data/jobs.db",
      POLL_INTERVAL_MS: 250,
      LEASE_MS: 30_000,
      RETRY_BASE_DELAY_MS: 250,
      RETRY_MAX_DELAY_MS: 30_000,
      WORKER_ID: "worker-1",
    });
  });

  it("coerces numeric environment values and trims identifiers", () => {
    expect(loadConfig({
      PORT: "8080",
      DB_PATH: " ./state/queue.db ",
      POLL_INTERVAL_MS: "50",
      LEASE_MS: "5000",
      RETRY_BASE_DELAY_MS: "100",
      RETRY_MAX_DELAY_MS: "2000",
      WORKER_ID: " worker-east-1 ",
    })).toMatchObject({
      PORT: 8080,
      DB_PATH: "./state/queue.db",
      RETRY_MAX_DELAY_MS: 2000,
      WORKER_ID: "worker-east-1",
    });
  });

  it("reports every invalid setting with its environment key", () => {
    expect(() => loadConfig({
      PORT: "70000",
      DB_PATH: "   ",
      POLL_INTERVAL_MS: "0",
      LEASE_MS: "-1",
      WORKER_ID: "",
    })).toThrowError(ConfigurationError);

    try {
      loadConfig({ PORT: "70000", DB_PATH: "" });
    } catch (error) {
      expect(String(error)).toContain("PORT");
      expect(String(error)).toContain("DB_PATH");
    }
  });

  it("rejects a retry cap below the base delay", () => {
    expect(() => loadConfig({
      RETRY_BASE_DELAY_MS: "1000",
      RETRY_MAX_DELAY_MS: "500",
    })).toThrow("RETRY_MAX_DELAY_MS: must be greater than or equal to RETRY_BASE_DELAY_MS");
  });
});
