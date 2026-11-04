## What and why

<!-- One or two sentences. Link the prompt or issue. -->

## Definition of Done

- [ ] `pnpm ci:local` passes (lint, typecheck, tests with coverage, e2e, audit, Storybook build, bundle size)
- [ ] New behaviour has tests; bug fixes have a test that failed before the fix
- [ ] Money is integer paise; no floats on money paths; tax figures come from `@gst/domain`
- [ ] Schema changes ship a migration for both SQLite and Postgres, and `pnpm --filter @gst/db db:generate` output is committed
- [ ] Every write goes through a repository (audit log, optimistic concurrency); no hard deletes
- [ ] UI uses design tokens only (no hard-coded colours or sizes) and works in light/dark and compact/comfortable
- [ ] Anything AI-suggested goes through a review item; nothing is applied silently
- [ ] No secrets, personal data or customer content in logs, fixtures or commits
- [ ] A changeset is added (`pnpm changeset`) for user-visible changes
- [ ] Docs updated (README, ADR or runbook) where behaviour changed

## Tax logic, return formats or rate data?

- [ ] Not touched
- [ ] Touched: the CA reviewer has signed off against `docs/compliance/tax-engine-review.md` (CR-08)

## Notes for the reviewer
