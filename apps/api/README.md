# api

The cloud tier (prompt 40): a Hono server on Node 22 over Postgres 16 with row-level security,
better-auth for identity and organisations, BullMQ on Redis for jobs, S3-compatible object storage,
OpenTelemetry and a Sentry-compatible error reporter. Provider-neutral: `infra/docker-compose.yml`
runs the whole thing locally and `infra/compose.prod.yml` is the one-host production shape.

## Run it

```
docker compose -f infra/docker-compose.yml up --build      # api on :8787, MinIO console on :9001
curl localhost:8787/readyz
pnpm --filter api dev                                       # or the API alone, against the compose services
```

Sign in without a mailbox: `POST /v1/auth/email-otp/send-verification-otp {"email","type":"sign-in"}`,
read the code from `GET /v1/dev/otp?to=<email>` (development only), then
`POST /v1/auth/sign-in/email-otp {"email","otp"}`; the `set-auth-token` header is the bearer token for
desktop and mobile, the cookie is for the browser. The document is at `/v1/openapi.json`.

## Layout

- `src/app.ts`: request ids, a logger per request, body and address limits, security headers, health and
  readiness, the OpenAPI document, the error envelope (`src/errors.ts`).
- `src/auth`: better-auth (`auth.ts`, email and phone codes, organisations with roles, two-factor, bearer),
  its tables (`schema.ts`, SQL in `migrations/0001_auth.sql`), the mirror into the shared `users`,
  `organisations` and `memberships` (`mirror.ts`), and the code senders (`otp.ts`: mock, log, MSG91).
- `src/middleware/session.ts`: who is calling, membership of the organisation in the path, the repository
  context (`app.org_id` on the transaction) and the role check.
- `src/routes`: `/v1/me`, `/v1/orgs` and businesses, files (signed URLs), admin (queues, usage), dev.
- `src/db`: the postgres.js pool as a `@gst/db` `Database`, and the migrator (shared schema, then
  `migrations/*.sql`, then the `gst_app` role).
- `src/jobs/queues.ts`: queues `recurring`, `dispatch`, `gsp`, `ai`, `pdf`, retries with backoff, the dead queue.
- `src/storage/s3.ts`, `src/telemetry.ts`, `src/errors-reporting.ts`, `src/limits.ts`, `src/config.ts`.

## Tests

`pnpm --filter api test` starts Postgres, Redis and MinIO in containers (Testcontainers; Docker needed) and
runs: the plumbing without services (`health`), the auth schema against the library's own field list,
sign-in and organisations with the tenant-isolation matrix over every table (`orgs`), signed uploads and
downloads (`storage`), retries and the dead queue (`jobs`), the OpenAPI contract (`contract`), and the
two-factor state (`two-factor`). `scripts/load.ts` measures latency against a running stack.
