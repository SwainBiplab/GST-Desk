# Runbook: messaging

1. Set the eight WhatsApp and Resend keys (`infra/env.md`); restart the API. `GET /v1/orgs/:id/messaging/status`
   reports which channels are configured (never the keys).
2. Webhooks: Meta, `https://<api>/v1/webhooks/whatsapp` with `WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`
   and `message_template_status_update`; Resend, `https://<api>/v1/webhooks/resend`. A wrong signature is a 401
   and nothing is stored.
3. Templates: owners open Settings, Messages, Templates, edit, Submit for approval, then Refresh status. A
   rejected template shows Meta's reason; edit and submit again.
4. Queue: the `messaging` queue and the 15-minute scan (reminders, recurring) run in the API process. A stuck
   message shows Failed with its error after 5 attempts; approve again from the log if the cause is fixed.
5. A recurring run that failed raises one inbox item (the owner sees the reason); fixing the source invoice's
   cause and resuming from Settings, Messages continues from the next date.
6. Never log or paste message bodies or addresses into tickets; use message ids.
