# Messaging sandbox acceptance

**Status: NOT RUN.** This needs a WhatsApp Business test number and a verified Resend domain from Leader
Group; neither was available when prompt 44 was built. Nothing below is a result. The automated tests use a
scripted `fetch` and hand-written webhook fixtures (B-188).

## Needs

`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`,
`WHATSAPP_VERIFY_TOKEN`, `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET`; the API reachable over https
for webhooks; a phone number added as a test recipient.

## Steps

| #   | Step                                                                                                     | Result  | Run by / date |
| --- | -------------------------------------------------------------------------------------------------------- | ------- | ------------- |
| 1   | Point Meta's webhook at `/v1/webhooks/whatsapp` with the verify token; the challenge succeeds            | not run |               |
| 2   | Point Resend's webhook at `/v1/webhooks/resend`                                                          | not run |               |
| 3   | Settings, Messages: Submit templates; Meta approves the English invoice template; Refresh shows Approved | not run |               |
| 4   | Issue an invoice for a party with WhatsApp opt-in; approve in the outbox; the PDF arrives on the phone   | not run |               |
| 5   | Status moves sent, delivered, read in the log within a minute                                            | not run |               |
| 6   | Same for e-mail: the PDF attached, delivered, opened                                                     | not run |               |
| 7   | Reply STOP on WhatsApp; the party shows opted out and the next reminder is not sent                      | not run |               |
| 8   | A bounce (invalid address) shows Bounced with the reason                                                 | not run |               |
