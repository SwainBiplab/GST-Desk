# features/data

Backup, restore, export, import and the trash (prompt 20, FR-120 to FR-122). The engine is `packages/db/src/backup`; this folder is the browser's side of it: where backups are kept, when they run, and the screens.

Read `docs/decisions/0011-backup-restore-export-and-trash.md` first. What a backup and an export contain is in `docs/export-schema.md` (generated from the schema).

## What is here

| File                | What it does                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-service.ts` | Make a backup (checked, kept, read back), the schedule, retention, the pre-migration backup, download, restore into a staging database, export and import. |
| `backup-store.ts`   | Where backup files live: the app's own storage, and a folder the person chooses (Chromium) that gets a copy of each.                                       |
| `data-tab.tsx`      | Settings, Backup: back up now, download, the folder, the schedule, the list, the restore dialog, export and import.                                        |
| `trash-tab.tsx`     | Settings, Trash: restore or delete for good, empty the trash.                                                                                              |
| `background.tsx`    | Quiet jobs while the app is open (daily backup, 30-day trash purge, old database copy removal) and the 7-day download reminder card.                       |
| `cloud.ts`          | Upload to the person's own Google Drive or OneDrive with credentials they supply. Desktop only.                                                            |
| `cloud-card.tsx`    | The cloud drive settings (desktop) or the note that says it is desktop only (browser).                                                                     |

Elsewhere: `app/db-location.ts` (which copy of the database the app opens, and the way back), `app/db-impl.ts` (the pre-migration backup and the fall-back), the bell (`app/components/chrome.tsx`, a failed backup), the dashboard (`features/reports/dashboard.tsx`, the reminder).

## How a restore works in the browser

1. The backup is checked: it is a backup, every checksum and row count matches, this app is new enough. Nothing is written.
2. A backup of what is on the device now is made.
3. A second database is built in its own OPFS directory (`/gst-desk-restore-…`), migrated, filled in one transaction, counted against the backup's list, and integrity-checked.
4. The app is pointed at it with one `localStorage` write, and the page reloads.
5. If the new database ever fails to open, the app goes back to the previous one by itself. The previous directory is removed after a week.

Any failure before step 4 leaves the live database untouched and removes the staging directory.

## Testing

```
pnpm --filter @gst/domain test      # when a backup is due, which to keep, reminders, the trash's 30 days
pnpm --filter @gst/db test          # backup, verify, restore, rollback, chaos (SIGKILL), export, import, trash
pnpm --filter web test              # cloud uploads (fake network), the database location switch
pnpm --filter @gst/db perf          # backup and restore of a 50,000-document book (PERF_DOCS=50000)
pnpm --filter web build && pnpm --filter web e2e e2e/backup.spec.ts
```
