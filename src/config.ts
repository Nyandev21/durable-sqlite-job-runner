import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DB_PATH: z.string().trim().min(1).default("./data/jobs.db"),
  POLL_INTERVAL_MS: positiveInteger.default(250),
  LEASE_MS: positiveInteger.default(30_000),
  RETRY_BASE_DELAY_MS: positiveInteger.default(250),
  RETRY_MAX_DELAY_MS: positiveInteger.default(30_000),
  WORKER_ID: z.string().trim().min(1).default("worker-1"),
}).superRefine((config, context) => {
  if (config.RETRY_MAX_DELAY_MS < config.RETRY_BASE_DELAY_MS) {
    context.addIssue({
      code: "custom",
      path: ["RETRY_MAX_DELAY_MS"],
      message: "must be greater than or equal to RETRY_BASE_DELAY_MS",
    });
  }
});

export type Config = z.infer<typeof schema>;

export class ConfigurationError extends Error {
  constructor(issues: z.core.$ZodIssue[]) {
    const details = issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    super(`Invalid runtime configuration: ${details}`);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(environment);
  if (!result.success) throw new ConfigurationError(result.error.issues);
  return result.data;
}
