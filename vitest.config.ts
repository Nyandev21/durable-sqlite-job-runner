import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { enabled: false },
    pool: "forks",
    testTimeout: 10_000,
  },
});
