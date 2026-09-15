import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DB_PATH: z.string().min(1).default("./data/jobs.db"),
  POLL_INTERVAL_MS: positiveInteger.default(250),
  LEASE_MS: positiveInteger.default(30_000),
  WORKER_ID: z.string().min(1).default("worker-1"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(environment);
}
