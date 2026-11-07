# Runbook: cloud AI (Tier 2)

1. Set `ANTHROPIC_API_KEY` on the API and restart. Without it `/v1/orgs/:id/ai/status` says `configured: false`
   and the Settings, AI tab says the server has no cloud model. `AI_MODEL` (default `claude-opus-5-5`) is the model
   for every route; `AI_ROUTE_MODELS` is JSON per route, for example
   `{"bill_extract":{"model":"claude-sonnet-5-5","effort":"high"},"draft_message":{"model":"claude-haiku-5-5"}}`.
   Change a route's model only after the eval (`pnpm --filter @gst/ai ai:eval --provider anthropic --model ...`)
   shows no loss on the golden set; record the run in `docs/ai/eval-results.md`.
2. The plan's `aiTokens` (plans.limits_json) is the month's allowance per organisation; the free plan has none. The
   status route and every answer carry `used`, `limit` and `warning` (80%); at the limit the gateway answers
   `402 ai_quota` and the app falls back to the offline tiers.
3. A business opts in under Settings, AI, Cloud AI: through the gateway (cloud plan) or, on the desktop, with its
   own Anthropic key, kept in the operating system's keychain (`secret_set`); the key never enters the book, a
   backup or a log. "Ask me before each scan or question" is on by default.
4. Where the calls show: `ai_calls` (feature, model, tokens, latency, outcome) and `usage_events` (`ai_tokens`),
   both without content; the API log line `ai call` carries the same. There is nothing to replay: prompts and answers
   are not kept anywhere.
5. `422 ai_refused`: the model declined (the category is in the message); the offline tiers answer. `422 ai_invalid`:
   the model answered out of shape; retry once, then file it with the feature and the model (never the content).
   `502 ai_unavailable`: the provider was rate limited or down; the SDK already retried twice.
6. Batches run on the `ai` queue: `queued` → `submitted` (a Message Batch at the provider) → polled every minute →
   `done` with per-item results, or `failed` with the error. A batch left `submitted` with the queue down is picked
   up when the worker restarts (its job is re-added with a delay); after a day of polling it fails.
7. GST Q&A answers only from `content/gst-corpus/`. To fix or add a note: edit the markdown (keep `source` and
   `date`), run `pnpm --filter @gst/ai ai:corpus`, commit `packages/ai/data/gst-corpus.json`, deploy. A question the
   corpus does not cover makes no model call.
8. Never put a bill's text, a notice, a question or a key in a ticket; use the feature, the model, the tokens and the
   time from `ai_calls`.
