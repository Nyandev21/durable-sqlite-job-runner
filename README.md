# Durable SQLite Job Runner

A focused TypeScript spike for durable background work on a single host. Jobs are
persisted in SQLite, claimed inside write transactions, protected by expiring
leases, and retried with exponential backoff.

## Why this project exists

Small services often need work to survive a process restart without immediately
adopting a separate broker. This project tests the boundary where SQLite is a
useful queue: one host, modest throughput, multiple worker processes, and jobs
whose handlers are safe to run more than once.

## Reliability model

- `BEGIN IMMEDIATE` serializes claim transactions across SQLite connections.
- A claim increments `attempts` and assigns both a worker ID and an expiry time.
- A different worker can reclaim an expired lease after a crash.
- Completion is conditional on the current worker ID, so a stale worker cannot
  overwrite a newer owner's result.
- Delivery is **at least once**. Handlers must be idempotent because a process can
  perform an external side effect and crash before recording completion.
- After `maxAttempts`, the job is retained with status `failed` for inspection.

This is intentionally not a distributed queue. SQLite database files must remain
on local storage; multi-host workloads should use a broker or database designed
for distributed coordination.

## Run locally

Requires Node.js 24 or newer (the project uses the built-in `node:sqlite` API).

```bash
npm install
npm run dev
```

Enqueue and inspect a job:

```bash
curl -s http://localhost:3000/jobs \
  -H 'content-type: application/json' \
  -d '{"kind":"uppercase","payload":{"text":"durable work"}}'

curl -s http://localhost:3000/jobs/JOB_ID
```

Built-in handlers are `uppercase` and `checksum`. The HTTP API accepts at most a
1 MB JSON request body.

Operational probes are available at `GET /health` for process liveness and
`GET /ready` for SQLite schema/connection readiness. Readiness returns HTTP 503
when the queue database cannot be queried.

Application logs are newline-delimited JSON. HTTP responses echo `X-Request-Id`
(or generate one when absent), and job lifecycle events include both the job ID
and worker ID so a request can be correlated with its background execution.

Jobs that exhaust their attempt budget remain persisted with status `failed`.
Operators can inspect the newest terminal jobs with `GET /dead-letter?limit=50`;
the limit is validated between 1 and 100.

## Configuration

Copy `.env.example` values into your runtime environment as needed:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `DB_PATH` | `./data/jobs.db` | SQLite database location |
| `POLL_INTERVAL_MS` | `250` | Delay while the queue is empty |
| `LEASE_MS` | `30000` | Time before another worker may reclaim a job |
| `RETRY_BASE_DELAY_MS` | `250` | Initial exponential retry delay |
| `RETRY_MAX_DELAY_MS` | `30000` | Upper bound for retry delays |
| `WORKER_ID` | `worker-1` | Stable identifier for this worker process |

Startup validates all values and reports invalid environment keys together. The
retry maximum must be greater than or equal to the base delay.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
docker build -t durable-sqlite-job-runner .
```

Unit tests cover exclusive claims, stale-worker protection, delayed retries, and
terminal failure. The integration test drives the HTTP API and a real worker
against SQLite. A multi-process stress test starts four competing Node processes
and verifies that all 60 jobs complete exactly once at the claim layer.

## Container

```bash
docker compose up --build
```

The named volume persists `/app/data/jobs.db` across container replacement.

## License

[MIT](LICENSE)
