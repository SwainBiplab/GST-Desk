# API latency

Budget (prompt 40, NFR-13): p95 under 150 ms for CRUD routes at 100 requests per second on a 2 vCPU
container with the seed loaded.

## Measured on 2026-11-07

`pnpm --filter api exec tsx scripts/load.ts --url http://localhost:8787 --rps N --seconds S` against
`infra/docker-compose.yml` (the API image, Postgres 16, Redis 7, MinIO, all in containers on the same
machine; one API process with a 10-connection pool). The mix is 90% reads (`/v1/me`, `/v1/orgs`, one
organisation, its businesses, one business) and 10% optimistic `PATCH` of a business. The load
generator runs on the same machine, so its own cost is in the numbers.

| Rate asked    | Achieved | p50      | p95      | p99      | max      | Errors       |
| ------------- | -------- | -------- | -------- | -------- | -------- | ------------ |
| 100 rps, 30 s | 100 rps  | 5.8 ms   | 10.9 ms  | 14.6 ms  | 43 ms    | 0 of 3,001   |
| 200 rps, 20 s | 200 rps  | 4.4 ms   | 10.1 ms  | 18.2 ms  | 67 ms    | 1 of 4,001   |
| 400 rps, 15 s | 312 rps  | 4,455 ms | 7,672 ms | 8,771 ms | 9,154 ms | 590 of 6,001 |

Machine: 11th-gen Intel i5-1135G7 (4 cores, 8 threads), containers without CPU limits. The budget is
met with a wide margin at 100 rps and still at 200 rps; one process saturates near 300 rps on this
machine (the pool, then the event loop), which is the point to add a replica behind the proxy.

## What this does not show

- A 2 vCPU container (B-165): run the same script with `cpus: '2'` on the api service and a separate
  load host, and record it here.
- The rate limits were raised for the development stack (`RATE_LIMIT_IP_PER_MINUTE` and
  `RATE_LIMIT_ORG_PER_MINUTE` at 100,000) because one client and one organisation make every request; in
  production the defaults (300 per address, 1,200 per organisation, per minute) would refuse a single
  organisation at 100 rps, which is the intent.
- Routes with heavier queries (documents, reports) arrive with sync and later prompts; measure them when
  they do.
