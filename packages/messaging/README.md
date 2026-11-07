# @gst/messaging

Provider adapters and scheduling rules for sending documents, receipts and reminders (prompt 44). Pure
TypeScript with no database: `apps/api` owns persistence, queues and routes.

- `MessagingAdapter`: `WhatsAppCloudAdapter` (media upload then template or document message, template
  submission and status, challenge and signature check), `ResendEmailAdapter` (attachments, idempotency key,
  Svix verification), and `MockAdapter` for tests.
- `advances(from, to)`: delivery status only moves forward, so a late webhook cannot undo a later one.
- `dueReminders`: the ageing rule engine (offsets, grace, quiet hours in IST); `nextRun`/`dueDates` for
  recurring invoices; `templates`: the default texts, variable rules and previews.

The non-English template texts are drafts for native-speaker review (B-189). Test fixtures are hand-written
from the providers' documentation, not recordings (B-188). Run `pnpm --filter @gst/messaging test`.
