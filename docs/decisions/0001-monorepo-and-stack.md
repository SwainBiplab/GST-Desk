# 0001 — Monorepo and stack

Status: accepted. Source: PRD section 12 (the stack index was empty when this was written).

## Decision

- pnpm workspaces + Turborepo; TypeScript end to end (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Frontend: React 19, Vite, TanStack Router/Query, Zustand, Tailwind, shadcn/ui, i18next.
- Desktop: Tauri v2 (`com.leadergroup.gstdesk`); web ships as a PWA.
- Local data: SQLite (Tauri SQL plugin / wa-sqlite) with Drizzle, shared with Postgres.
- Quality: Vitest, Playwright, ESLint flat config, Changesets, GitHub Actions.
- Packages: `@gst/domain`, `db`, `ui`, `ai`, `i18n`, `config`; apps: `web`, `desktop`.

## Consequences

Later phases add `apps/mobile` and `apps/api`; open decisions are listed in PRD 12.4.
