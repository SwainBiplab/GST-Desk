# Numbering, period lock and audit (`features/numbering`)

Settings → Numbering (number series and the period lock), Settings → Audit (the audit trail), and the lock-override prompt used by the document editor. See `docs/decisions/0006-numbering-cancellation-and-audit.md` and `docs/compliance/numbering-and-cancellation.md`.

| File                | What it does                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `numbering-tab.tsx` | Series per document type: add, edit, remove (unused only), defaults per type and shell, live preview, problems from `validateSeries`; the period lock panel |
| `lock-override.tsx` | `useLockOverride()`: asks an owner for a reason when a date is in a locked period                                                                           |
| `audit-viewer.tsx`  | Filter by record type, user, dates or document number; before/after per entry; CSV export                                                                   |
| `audit-diff.tsx`    | A field-by-field before/after table for one audit entry                                                                                                     |
| `audit.ts`          | `diffRows` (ignores version and timestamps) and `auditCsv` (one row per changed field, formulas neutralised)                                                |

Document-side pieces live in `features/documents`: `cancel-dialog.tsx`, `history-tab.tsx`, the Edit / Save changes flow in `use-editor.ts` and `editor-page.tsx`, and the series picker in `editor-header.tsx`.

The rules themselves are in `@gst/domain` (`series.ts`, `numbering.ts`) and `@gst/db` (`NumberingRepo`, `PeriodLockRepo`, `DocumentFlowRepo.cancelDocument` / `reviseIssued` / `editIssuedNotes`). The UI never decides what is allowed; it asks and shows the repository's answer.

Tests: `audit.test.ts` (unit), `e2e/numbering.spec.ts` (Playwright), `packages/db/src/repositories/after-issue.test.ts` (both databases, including the 1,000-document stress test).
