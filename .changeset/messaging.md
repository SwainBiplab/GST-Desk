---
'@gst/messaging': minor
'@gst/print': minor
'@gst/ai': minor
'@gst/i18n': minor
'api': minor
'web': minor
---

Messaging (prompt 44). Documents, receipts and reminders go to customers by WhatsApp (Business Cloud API, approved templates in six languages) and e-mail (Resend) from the cloud tier. Messages wait for approval unless automatic sending is on for that kind; consent is recorded per channel and re-checked at send time; delivery status (sent, delivered, read, bounced) comes back by signed webhooks and shows in a log on the document and the party. Reminders follow ageing rules (before the due date, on it, then 7 and 15 days after) outside quiet hours. Recurring invoices are issued by the server on a schedule, catch up after an outage, and raise one inbox item when a run fails. The Settings, Messages tab holds the outbox, rules, templates and repeating invoices. The sandbox send was not run: no provider credentials were available.
