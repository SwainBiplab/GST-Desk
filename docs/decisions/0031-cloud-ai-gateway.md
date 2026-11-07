# 0031 — Tier 2: the cloud AI gateway and a person's own key

Status: accepted. Context: prompt 48, PRD FR-176 to FR-178, sections 9.4 and 9.6, Principle 3 (AI proposes, people dispose).

## Decision

- **One provider, two homes.** `AnthropicProvider` (`@gst/ai`) speaks to Claude through the official SDK and is the
  router's Tier 2. In the cloud tier it lives inside the API's gateway with the platform's key; on the desktop a
  person may give their own key, kept in the operating system's keychain, and the app then calls the provider
  directly with the same masking and review rules. Either way the router asks Tier 2 only when the request says
  `allowCloud: true`, and the business must have opted in (`ai.settings.cloud.enabled`, off by default); "ask every
  time" is on by default.
- **The answer is always a schema.** Extraction and the explainers use structured output (`output_config.format`
  from the Zod schema, built by the package so one check, `validated`, decides) and nothing half-valid comes back;
  tools for ask-your-books are declared `strict` and the model is never forced to call one (`tool_choice` is never
  sent). A refusal (`stop_reason: "refusal"`) is `ok: false` with a plain message and the next tier answers; the
  request opts into server-side fallbacks by category (`fallbacks: "default"`), so a policy decline on the primary
  model is retried by the service on a model that may answer. Adaptive thinking is left at the model's default;
  effort and model are set per route (`AI_ROUTE_MODELS`), the default being `claude-opus-5-5` everywhere until the
  evals say a step-down loses nothing (see `docs/ai/eval-results.md`: not run here, no key).
- **A stable prefix, cached.** The system text per route, then the business profile line and an HSN excerpt (the
  codes the business uses, read once per five minutes so the bytes stay identical), with `cache_control` on the
  last block; everything that changes per request is the user turn. The tests assert the same prefix bytes on the
  second call and a non-zero cache read.
- **Masking before, restoring after.** PAN, bank account and Aadhaar numbers in text are replaced by tokens in the
  provider before the text leaves and put back in what comes back; the prompt tells the model to copy a token, never
  guess it. Images and PDFs cannot be masked and are sent as they are when the person chooses to send the file. No
  route needs the real numbers.
- **The gateway meters and keeps no content.** Each call checks the plan (`limits.aiTokens`) and the month's
  usage (`usage_events` kind `ai_tokens`): a soft warning at 80% rides on every answer, and at the limit the call is
  refused before it is made with a plain error, which the app's router turns into the Tier 1 fallback. The attempt
  goes to `ai_calls` (feature, provider, model, tokens, latency, outcome) and the log line carries the same; prompts
  and answers are never stored or logged.
- **Ask-your-books is read-only by construction.** The tools are the report runner (`sales_register`,
  `purchase_register`, `gst_summary`, `document_summary`, `party_outstanding`) and two searches, every one through
  the repository context of the business the caller may read, forty rows at most, results capped at 12 KB, up to
  six rounds. The system text says tool results are data, not instructions, and that the assistant cannot change
  anything, because it cannot: there is no writing tool.
- **GST Q&A cites a curated corpus, not the model's memory.** `content/gst-corpus/*.md` (summaries of the Act, the
  rules and notifications, each with source and date) is chunked and indexed at build time; the gateway retrieves
  the top chunks with BM25 and hands them to the model as documents with citations on; the answer returns the
  sources it cited (or the chunks it was given) and the not-legal-advice line, and a question the corpus does not
  cover gets no model call. The corpus itself awaits a chartered accountant's review (B-215).
- **Batches.** Many bills or statement lines go as one Message Batch (half price, up to a day) on the `ai` queue:
  submitted, polled every minute, the results checked per item and the tokens metered.
- **Streaming** is used for every call (`stream` + `finalMessage`), so nothing waits on a long answer past a
  request timeout; the gateway's routes answer JSON once the message is complete.

## Consequences

- Nothing in the product needs the cloud: the rules and the offline model keep working, and the cloud raises
  accuracy or adds depth (explanations, notices, questions) only when the business asked for it.
- A refusal, a quota or an outage is a plain message and a fallback, never a half answer or a stuck screen.
- The corpus is the limit of GST Q&A, by design: a wrong answer from a curated note is a note to fix, not a model
  to argue with.

## Not verified here

No Anthropic API key was available in this environment: the provider is tested with the SDK's HTTP mocked
(`packages/ai/test/cloud.test.ts`) and the gateway against Postgres with the same mock (`apps/api/test/ai.test.ts`).
The golden-set run against the live model, its accuracy and cost per bill, and the step-down decisions are recorded
as pending in `docs/ai/eval-results.md`. The desktop keychain commands (`secrets.rs`, the `keyring` crate) compile
only on a machine with the platform's keychain libraries and have not been built here (B-216).
