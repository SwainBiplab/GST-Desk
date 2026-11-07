# @gst/ai

Provider abstraction for every AI feature, plus the Tier 0 rules backend, a mock for tests, redaction,
review items and an eval harness. No network access lives in this package; real model backends arrive in
prompts 36 (local) and 48 (cloud).

Two entry points:

- `@gst/ai` is browser-safe (no database): router, providers, redaction, schemas, eval harness.
- `@gst/ai/db` needs `@gst/db`: `createReviewItem`, `acceptReviewItem`, `rejectReviewItem`, `DbCallLogger`, `createDbRulesEnv`.

## The contract: AI proposes, people dispose

1. A feature asks the router for a suggestion or extraction with a Zod schema. Providers return a value that passes the schema, or `{ ok: false }`. A half-valid object never comes back.
2. The result becomes a **review item** (`createReviewItem`), stored as `pending` with a diff against the user's current data.
3. A person accepts, edits or rejects it. Only `acceptReviewItem` calls the feature's `apply(value, ctx)`, inside one transaction. Edits are validated, applied instead, and stored as `correction_json` so evals can learn from them.
4. An actor named `ai:...` can never accept or reject.

## Tiers and the router

| Tier | Backend                           | When used                                     |
| ---- | --------------------------------- | --------------------------------------------- |
| 0    | `rules`                           | always offline, deterministic                 |
| 1    | `local-llama`, `ollama`, `webllm` | if configured and the hardware fits           |
| 2    | `anthropic`                       | only when the request sets `allowCloud: true` |

`AiRouter.plan(capability, allowCloud)` returns providers best first (Tier 2, 1, 0) and the router falls
through on any error, thrown exception or invalid output. **Tier 2 is never contacted without `allowCloud: true`**,
whatever the settings say. `askBeforeCloud` is a hint for the UI: ask the user, then set the flag.
Every attempt is passed to an `AiCallLogger`; `DbCallLogger` writes `{ feature, provider, model, tokens, latency,
outcome }` to `ai_calls`. Prompts and responses are never logged.

```ts
const router = new AiRouter({
  settings: { tier0: true, tier1: null, tier2: null, askBeforeCloud: true },
  providers: [new RulesProvider({ hsn: new InMemoryHsnLookup(entries) })],
});
const r = await router.suggest(
  { feature: 'hsn_lookup', input: { description: 'steel pipes' } },
  hsnSuggestionsSchema,
);
```

## Add a backend

Extend `BaseProvider` (unimplemented capabilities report `unsupported`), set `id` and `capabilities()`, and
implement the methods you support. Always build results with `validated(schema, candidate, meta)` so output
is checked against the caller's schema. Register the instance with the router and add its id to
`RouterSettings` if it needs its own tier slot. Mask personal data with `redact()` before anything leaves
the device, and `restore()` the response.

## Add a rule (Tier 0)

```ts
rules.registerRule('my_feature', async (input, env) => ({ value: { ... }, confidence: 0.9 }));
```

A rule receives the feature input and a `RulesEnv` (`hsn`, `parties`) and returns a proposal. Throwing reports
`rule_failed` and the router moves on. Built in: `hsn_lookup` (BM25 over descriptions: FTS5 on SQLite,
tsvector on Postgres, or `InMemoryHsnLookup` in the browser) and `duplicate_party` (GSTIN, phone, normalised name).

## The review inbox (Tier 0 assistants)

`src/inbox` holds the twelve inbox kinds with a schema for each (`kinds.ts`), the pure detectors (`detectors.ts`:
duplicate parties and items, HSN suggestions, GST rate changes, old drafts, overdue reminders, low stock, failed
backups) and the lifecycle (`lifecycle.ts`: `pending → accepted | rejected | expired`, snooze as a time on a pending
item, and `reconcile`, which turns "what the rules found now" and "every key ever raised" into what to create and
what to close). `src/db/inbox.ts` is the part that touches the database: `runTier0` (idempotent), `applyReviewItem`
and `acceptReviewItems` (apply through the owning repository in one transaction), `bulkCandidates`. See
`docs/decisions/0012-review-inbox-and-tier-0-assistants.md`.

To add a kind: a schema in `kinds.ts`, an entry in `KIND_INFO`, a detector, a case in `applyValue`, and a line in the
web `features/inbox/model.ts`.

## Tier 1: local models (prompt 36)

`src/local` holds everything that runs a model or reads a scan on the device, all of it browser-safe:

- `hardware.ts`, `manifest.ts`, `models.ts`: device classes, the signed model manifest (Ed25519), and the
  `ModelManager` (licence per model, resumable Range downloads, SHA-256 check, pause, delete, disk use) over a
  `ModelStorage` and a `RangeFetcher`, so it runs in tests, Node, the desktop and OPFS alike.
- `grammar.ts`: a GBNF grammar from a Zod schema, and `extractJson` for prose-wrapped answers.
- `runtime.ts`: `keeper` starts a sidecar on first use, runs one call at a time and stops it when idle.
- `structured.ts`, `prompts.ts`: the shared prompt-generate-parse-validate path; `llama.ts`, `ollama.ts`,
  `webllm.ts`: the three Tier 1 providers.
- `embed.ts`: cosine, the hashed-trigram embedder, the brute-force index and the hybrid (BM25 + vector) HSN lookup.
- `ocr/`: preprocessing (grey, denoise, Otsu, deskew, crop), layout (boxes to lines), the sidecar OCR client, a
  fixture engine and a PNG writer.
- `extract/`: the rules extractor (`extractBillFromText`), supplier and item matching, and `extractPurchaseBill`
  (OCR, rules, model, merge, match, engine check).
- `voice/parse.ts`: speech to a draft without a model; `drafting.ts`: template fill and a guarded paraphrase.
- `tier0.ts`: `withTier0Local` registers the bill extractor and the speech parser on a `RulesProvider`.

`src/db/adapters.ts` adds `indexHsnMaster`, `loadHsnVectors` and `hybridHsnLookupFor` over `hsn_embeddings`;
`src/db/inbox.ts` applies an accepted `ai_extraction` as a purchase draft with the scan attached.
`scripts/make-manifest.ts` builds and signs the manifest; `scripts/make-bills.ts` makes the golden set.
See `docs/decisions/0022-tier1-local-ai.md`, `docs/ai/local-models.md`, `docs/ai/eval-results.md`.

## Evals

`pnpm ai:eval --provider mock|rules|ollama|llama [--schema purchaseBill] [--model m] [--url http://...] [--markdown]`
runs a provider over the fixtures (`{ name, input, expected, mock? }`; `expected` may be partial) and prints
field-level accuracy and latency. `purchaseBill` reads `fixtures/purchaseBill`, `fixtures/bills` (60 synthetic
bills) and `fixtures/bills/real`; `voiceDraft` reads eight spoken sentences. `ollama` and `llama` need a server
already running. Add a schema to `SCHEMAS`, a mode and a folder in `scripts/eval.ts` to cover a new feature.

`--accepted <file.sqlite>` also scores `hsnSuggestion` against the HSN suggestions a person accepted in that local
database, using their correction where they edited it (read only, nothing leaves the machine).

## Tests

`pnpm --filter @gst/ai test`: router fallback and cloud gating, redaction (PAN, account numbers, Aadhaar with Verhoeff
checksum), review accept/edit/reject on SQLite and Postgres, and HSN top-3 for 20 sample descriptions on the in-memory
index and both databases.
