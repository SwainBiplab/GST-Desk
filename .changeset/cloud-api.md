---
'api': minor
'@gst/db': patch
'web': minor
---

The cloud tier (prompt 40): `apps/api`, a Hono server on Node 22 over Postgres 16 with row-level security, better-auth for password-less sign-in (email and phone codes), organisations with six roles, cookie and bearer sessions, and a mirror into the shared `users`, `organisations` and `memberships`. Routes under `/v1` are Zod contracts that generate the OpenAPI document; a contract test walks it. Businesses are created and changed through the shared `BusinessRepo`, audited. Files go through signed URLs to S3-compatible storage with server-side encryption; jobs run on BullMQ with retries and a dead-letter queue; rate limits per address and per organisation; the process refuses default secrets outside development. `infra/` holds the compose stacks, a distroless image, the collector, a Grafana dashboard, the daily backup and the environment reference. Tests run against real Postgres, Redis and MinIO in containers, including a tenant-isolation matrix over every table. The web app gains Settings, Cloud: sign in with a code, make an organisation and a business on the server.
