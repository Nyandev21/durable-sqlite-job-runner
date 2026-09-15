# Recovery runbook

## Process crash

Each claim stores a worker identity and lease expiry in the same transaction that moves the job to `running`. A replacement worker can reclaim it after that lease expires. The old worker cannot complete the reclaimed job because completion is conditional on both status and worker identity.

The guarantee is at-least-once, not exactly-once: a worker can finish an external side effect and crash before committing success. Job handlers therefore need an idempotency key or an equivalent application-level deduplication mechanism.

## Operational checks

1. Check `/ready` for database access and `/stats` for queued, running, failed, and currently claimable counts.
2. After a crash, allow at least `LEASE_MS` for abandoned work to become claimable.
3. Inspect `/dead-letter` for exhausted jobs. Correct the issue before using `POST /jobs/:id/retry`.
4. Preserve the database file and its WAL/SHM sidecars together during recovery. Do not place the live database on a network filesystem.

## Contention check

```bash
npm run soak -- --jobs 1000 --workers 4
```

The command exits non-zero for missing or duplicate completions and reports how many processes performed useful work.
