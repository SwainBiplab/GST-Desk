# 0027 — Messaging: WhatsApp, e-mail, reminders and recurring invoices

Status: accepted. Context: prompt 44, PRD messaging requirements, cloud tier.

## Decision

- **Server-side, cloud tier only.** Sends run in the API (BullMQ queue, retries up to 5 with back-off), not in
  the app, so they work when the phone is off and credentials never reach a device. A free book keeps the
  share sheet. The plan gate is the plan's `messages` limit against `usage_events`.
- **Platform credentials.** One WhatsApp number and one Resend sender for the whole platform, from the
  environment (`infra/env.md`). Per-organisation numbers are B-193.
- **Templates.** WhatsApp only delivers approved templates outside the 24-hour window. Each organisation gets
  `gd_<8 hex of org id>_<kind>` in six languages and three kinds; the owner edits the text (live preview,
  Meta's rules checked locally: no variable first or last, matched variables), submits, and refreshes the
  status. Non-English texts are drafts for review (B-189).
- **Consent.** WhatsApp needs an explicit recorded opt-in (`party_consent`); e-mail is sent unless the party
  opted out; STOP and unsubscribe arrive by webhook. Consent is re-checked at delivery. Any opt-out stops
  reminders.
- **Approval.** A message waits in the outbox (approve, edit, reject) unless `auto_send[kind]` is on.
- **Status and webhooks.** Signature first, over the raw body; events are idempotent (`webhook_events.event_key`);
  `advances()` keeps status monotonic; the timeline is ordered by `(at, seq)`.
- **Reminders.** Offsets -3, 0, 7, 15 days from the due date, a 2-day grace so an outage does not fire stale
  rules, only the latest unsent rule per document, quiet hours 21:00 to 09:00 IST, only tax invoices, bills of
  supply and debit notes.
- **Recurring invoices.** The server copies a source invoice through the same draft, issue and numbering path
  as a person (so tax and numbers stay deterministic), one run per date, catches up after an outage, and raises
  one `recurring_failed` inbox item per failing date.
- **Logs carry no personal data**: ids, kind and channel only.

## Not done

Sandbox sends (no credentials), real webhook recordings, logos in server PDFs, messaging from web and desktop
books until they have a sync client. See B-188 to B-193.
