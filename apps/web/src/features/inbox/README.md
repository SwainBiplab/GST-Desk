# features/inbox

The review inbox (prompt 21, FR-171, FR-175, FR-177, FR-178, UX-02) and the quiet job runner that fills it. Read `docs/decisions/0012-review-inbox-and-tier-0-assistants.md` first.

## What is here

| File             | What it does                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inbox-page.tsx` | The page. Books: a virtualised table with a detail panel. Shop: simple cards with the buttons on them. Dialogs for reject, edit and bulk accept. |
| `model.ts`       | Pure: what a row says, its before/after lines, where "Open record" goes, which kinds can be accepted or edited, filters, the WhatsApp link.      |
| `hooks.ts`       | The three lists (to review, snoozed, done), the automatic-rule setting, and `runChecks`.                                                         |
| `jobs.tsx`       | `InboxJobs`: runs the rules on open, every six hours, and after a party or item is saved.                                                        |
| `auto-rules.tsx` | The dialog for the one automatic rule (off by default).                                                                                          |

The rules themselves are in `packages/ai/src/inbox` (kinds, detectors, lifecycle) and `packages/ai/src/db/inbox.ts` (`runTier0`, `applyReviewItem`, `acceptReviewItems`).

## Keys

J / K move, A accept, E edit, R reject, S snooze, O open the record. They are listed in `app/shortcuts.ts` and `docs/keyboard.md`.

## Scale check

`/books/inbox?demo=1&inbox=5000` loads the demo book plus 5,000 waiting items of a kind no rule closes.

## Testing

```
pnpm --filter @gst/ai test                  # detectors, lifecycle, runTier0 on both databases, bulk, auto-rule off by default
pnpm --filter @gst/db test                  # inbox views, snooze, counts, item merge
pnpm --filter web test                      # the row model
pnpm --filter web build && pnpm --filter web e2e e2e/inbox.spec.ts
```
