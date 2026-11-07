---
'@gst/ai': minor
'@gst/i18n': minor
'api': minor
'web': minor
'desktop': minor
---

Tier 2 cloud AI (prompt 48). `AnthropicProvider` in `@gst/ai` speaks to Claude through the official SDK with
structured output checked against the route's schema, a cached stable prefix, masking of PAN, bank and Aadhaar
numbers before text leaves, strict tools without forced tool choice, streaming, server-side fallbacks and a plain
`ok: false` on a refusal. The API gains a gateway under `/v1/orgs/:id/ai/*`: extract a bill, explain a GSTR-2B
mismatch, summarise a notice, ask your books over read-only report tools, GST Q&A with citations over a curated
corpus (`content/gst-corpus`), draft a message, and batches through the Message Batches API; every call checks the
plan and the month's token quota (80% warning, hard stop), meters into `usage_events` and `ai_calls`, and keeps no
content. The app opts in per business (off by default, ask-each-time by default), scans can go through the gateway,
reconciliation rows get Explain, and the GST page gets an assistant; the desktop may use a person's own key kept in
the operating system's keychain. Not run against the live model here (no key): the evals are pending.
