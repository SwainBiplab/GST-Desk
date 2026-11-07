# The API's environment

Every setting the API reads, from `apps/api/src/config.ts`. Secrets come only from the environment; in
production the process refuses to start with a default secret, a mock code sender, a plain-http base URL
or MinIO's default credentials.

| Variable                                        | Required   | Default                 | Meaning                                                                                                                                                             |
| ----------------------------------------------- | ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                      |            | `development`           | `development`, `test` or `production`. Production turns on the checks below.                                                                                        |
| `PORT`                                          |            | `8787`                  | Listening port.                                                                                                                                                     |
| `DATABASE_URL`                                  | yes        |                         | The owner's connection. Used only to run migrations at start.                                                                                                       |
| `APP_DATABASE_URL`                              | production | `DATABASE_URL`          | The `gst_app` role's connection. Every request runs on it, so row-level security applies.                                                                           |
| `APP_DB_PASSWORD`                               |            |                         | Set at migration time as the `gst_app` role's password.                                                                                                             |
| `REDIS_URL`                                     |            |                         | Jobs and shared rate limits. Without it, jobs are off and limits are per process.                                                                                   |
| `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` |            |                         | Object storage. Without them file routes answer 503.                                                                                                                |
| `S3_BUCKET`                                     |            | `gstdesk`               | One bucket; keys are `orgs/<orgId>/<kind>/<name>`.                                                                                                                  |
| `S3_REGION`                                     |            | `ap-south-1`            | Signing region.                                                                                                                                                     |
| `S3_FORCE_PATH_STYLE`                           |            | `true`                  | `true` for MinIO; `false` for most managed S3.                                                                                                                      |
| `S3_SSE`                                        |            | `AES256`                | Server-side encryption header on uploads. `none` only for a MinIO without a key service (refused in production).                                                    |
| `AUTH_SECRET`                                   | production | dev secret              | 32+ random characters; signs sessions.                                                                                                                              |
| `BASE_URL`                                      | production | `http://localhost:8787` | Public URL of the API; https in production.                                                                                                                         |
| `TRUSTED_ORIGINS`                               |            | localhost ports         | Comma-separated origins allowed to use cookie sessions (the web app, `tauri://localhost`).                                                                          |
| `OTP_PROVIDER`                                  |            | `mock`                  | `mock` (codes kept in memory, read from `/v1/dev/otp`), `log` (printed), `msg91` (SMS; email arrives with prompt 44).                                               |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`           | with msg91 |                         | MSG91 OTP API.                                                                                                                                                      |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                   |            |                         | The collector (`http://otel-collector:4318`). Off when unset.                                                                                                       |
| `SENTRY_DSN`                                    |            |                         | Error reports, scrubbed. Off when unset.                                                                                                                            |
| `INTERNAL_ORG_ID`                               |            |                         | The organisation whose owners may open `/v1/admin/*`.                                                                                                               |
| `RATE_LIMIT_IP_PER_MINUTE`                      |            | `300`                   | Per address.                                                                                                                                                        |
| `RATE_LIMIT_ORG_PER_MINUTE`                     |            | `1200`                  | Per organisation (signed-in routes).                                                                                                                                |
| `MAX_BODY_BYTES`                                |            | `2097152`               | Largest request body. File bytes never pass through the API.                                                                                                        |
| `TRUST_PROXY`                                   |            | `false`                 | `true` only behind a TLS proxy: the client address is then read from `X-Forwarded-For`, which a direct client could otherwise forge to dodge the per-address limit. |
| `LOG_LEVEL`                                     |            | `info`                  | pino level.                                                                                                                                                         |
| `API_MIGRATIONS_DIR`                            |            | `./migrations`          | Where the API's own SQL files are (the image sets `/app/migrations`).                                                                                               |

## Data residency

Run every service of `compose.prod.yml` (or the managed equivalents) in an India region: for AWS
`ap-south-1`/`ap-south-2`, for GCP `asia-south1`/`asia-south2`, for Azure Central/South India, or a
domestic provider. Object storage, the database, Redis and the collector's upstream all hold customer data
or metadata; the error reporter and the telemetry upstream must be in-region too or disabled. Nothing in
the API depends on a provider-specific service.

## Secrets

Generate: `AUTH_SECRET` and `APP_DB_PASSWORD` with `openssl rand -base64 48`; MinIO's KMS key with
`openssl rand -base64 32`. Keep them in the host's secret store or a `.env` with mode 600 next to
`compose.prod.yml`; never in the repository.
