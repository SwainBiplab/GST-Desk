# 0023 — The cloud tier: API, identity, tenancy, deployment

Status: accepted. Context: prompt 40, PRD FR-132, FR-133, NFR-05, NFR-07, NFR-13, NFR-14, section 12.1.

## Decision

- **One schema, two homes.** The cloud database is the same spec-driven schema the desktop and the browser
  run (`@gst/db`), migrated by the same `migrate()`, plus the API's own tables (`apps/api/migrations`:
  better-auth's, billing, the app role, an operator view). Repositories are shared: the API calls
  `BusinessRepo` the way the desktop does, so a rule and an audit row are the same in both places.
- **Two database roles.** Migrations run as the owner; every request runs as `gst_app`, which owns nothing,
  so Postgres enforces the tenant policy on it. `runInTx` sets `app.org_id` on every transaction, and a
  query outside one fails rather than leaking: the matrix test seeds a full demo book in one organisation
  and reads every tenant table as another (41 tables, zero rows), then checks an update under the wrong
  organisation changes nothing.
- **better-auth, mirrored.** Identity, sessions, organisations, members and two-factor are better-auth's,
  in `auth_*` tables; hooks copy users, organisations and members into the shared `users`,
  `organisations` and `memberships` so the policies and the repositories see them. The auth schema is
  hand-written from the library's own field list and a test fails when the library expects a field it does
  not have. Password-less: email and phone one-time codes (6 digits, 5 minutes, 5 attempts). Cookies for
  the browser with the library's origin check as CSRF protection; bearer tokens for the desktop and mobile.
- **Roles are access-control statements.** owner, admin, accountant, sales, inventory, viewer, each a set
  of `resource: actions`; a route names what it needs (`requirePermission('business', 'create')`). The
  shared `memberships.role` enum is narrower (sales and inventory map to `staff`) until prompt 42 widens it.
- **Every route is a contract.** `@hono/zod-openapi` routes carry their schemas; the document at
  `/v1/openapi.json` is generated from them, and the contract test walks it: every operation declares a
  JSON response, every protected one refuses an anonymous caller with the error envelope, the public ones
  are exactly health, readiness, the document and (outside production) the dev code, and the live shapes
  match the components.
- **Files never pass through the API.** Signed PUT and GET URLs (ten minutes) to an S3-compatible store,
  keys made on the server under `orgs/<orgId>/<kind>/<name>`, type and size checked before signing,
  server-side encryption on uploads (`S3_SSE`, refused off in production), lifecycle rules for temporary
  objects and backups.
- **Jobs on BullMQ.** Five queues, exponential backoff, a dead queue that keeps a job after its last
  attempt with why it died, a requeue for operators, counts for the dashboard. Redis also backs the
  shared rate limits when present; a single process falls back to memory.
- **Refuse to run wrong.** Production refuses the default auth secret, a mock code sender, a plain-http
  base URL, MinIO's default credentials and unencrypted uploads at start.
- **Provider-neutral.** Postgres, Redis, MinIO and the OpenTelemetry collector in `infra/docker-compose.yml`
  (local) and `infra/compose.prod.yml` (one host, India region; managed services by changing URLs). A
  distroless Node 22 image. Daily `pg_dump` to the bucket, 30 days kept. No provider SDK anywhere.
- **Observability without personal data.** pino with a redaction list; OTLP traces and metrics (request
  duration by route and status, queue depth) to the collector, which drops identifying attributes; a
  Sentry-compatible reporter whose messages are scrubbed of emails, phones, GSTINs, PANs and long numbers,
  with no request bodies attached.
- **Billing hooks only.** `plans`, `subscriptions` (every organisation starts on `free`) and `usage_events`
  (GSP calls, messages, AI tokens, PDF renders, storage) exist with RLS; nothing is charged. Operators read
  usage across organisations through a view owned by the migration user.

## Consequences

- The web app's Settings, Cloud tab signs in with a code, makes an organisation and a business on the server
  (the acceptance flow), and keeps the bearer token in local storage for now; the desktop keychain is B-060.
- TOTP two-factor is wired (plugin, tables, routes) but better-auth 1.7 needs an account password to enable
  it and our accounts have none: B-160. Email delivery of codes is the messaging prompt's (44); until then
  the `log` and `mock` senders and MSG91 for SMS.
- Latency: measured by `scripts/load.ts` against the compose stack; see `docs/perf/api.md` for the numbers
  from this machine and what the 2 vCPU target still needs.
- Semgrep and gitleaks are still not in CI (B-089); the API's own checks (contract test, RLS matrix, config
  refusals) run on every push, with Docker on the runner.
