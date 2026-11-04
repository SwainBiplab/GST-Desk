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

## Evals

`pnpm ai:eval --provider mock [--schema purchaseBill]` runs a provider over `fixtures/<schema>/*.json`
(`{ name, input, expected, mock? }`; `expected` may be partial) and prints field-level accuracy. Offline providers:
`mock` and `rules`. Add a schema to `SCHEMAS` and a fixtures folder to cover a new feature.

## Tests

`pnpm --filter @gst/ai test`: router fallback and cloud gating, redaction (PAN, account numbers, Aadhaar with Verhoeff
checksum), review accept/edit/reject on SQLite and Postgres, and HSN top-3 for 20 sample descriptions on the in-memory
index and both databases.
