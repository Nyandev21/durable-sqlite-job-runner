import { runConcurrencySoak } from "./soak.js";

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const raw = index === -1 ? undefined : process.argv[index + 1];
  return raw === undefined ? fallback : Number(raw);
}

const result = await runConcurrencySoak({ jobs: option("jobs", 1_000), workers: option("workers", 4) });
process.stdout.write(`${JSON.stringify(result)}\n`);
