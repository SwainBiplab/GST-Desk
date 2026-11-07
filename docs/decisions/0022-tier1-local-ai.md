# 0022 — Tier 1 local AI: bill scanning, semantic HSN, voice, regional drafting

Status: accepted. Context: prompt 36, PRD FR-172 to FR-175, sections 9.2, 9.3, 9.5, NFR-02, Principle 3 (AI proposes, people dispose).

## Decision

- **Rules first, a model on top.** Every feature here works with no model at all: a purchase bill is read by
  patterns (`extractBillFromText`), a spoken sentence by a grammar of numbers, units and party markers
  (`parseSpeech`), HSN search by BM25 with a spelling-tolerant vector index (`HashEmbedder`), and a message
  by a filled template. A local model, when the person has downloaded one, answers the same question and the
  two answers are merged field by field: agreement raises the confidence, disagreement lowers it and the more
  confident side wins. The model never replaces the rules, so the product behaves the same on a machine that
  cannot run one, and the evals measure a model against a floor (`docs/ai/eval-results.md`: rules alone reach
  90.1% on the synthetic set).
- **The model is constrained, then checked.** A llama.cpp call carries a GBNF grammar made from the Zod
  schema (`gbnf`), Ollama gets the JSON schema as `format`, WebLLM gets it as `response_format`; so the model
  can only answer in the shape asked for. The answer is still validated against the schema and nothing half-valid
  comes back. Money is asked for in rupees with decimals and converted to paise in code, so a 1.5B model never
  multiplies by 100.
- **Totals are the engine's.** An extraction is priced by `buildDocument` before anyone sees it, and a bill
  whose own total differs by more than a rupee is flagged. Accepting an extraction makes a purchase **draft**
  (`applyExtraction`) priced again by the engine, with the scan attached and the bill's own figures kept in the
  metadata for the audit; the person issues it from the editor. Nothing touches the books before accept, and
  an AI actor cannot accept (the inbox contract from ADR 0012).
- **Models are files the person chose.** Nothing ships in the installer. A signed manifest
  (`apps/web/public/ai/models.json`, Ed25519, key in `packages/ai/data/model-signing-key.json`) lists each
  model's size, SHA-256 and licence; a model is offered only if its memory need fits the machine, downloaded
  only after its licence is accepted, resumed with a Range request after a pause or a crash, and called ready
  only when its hash matches. The manifest's sizes and hashes come from the hosts (Hugging Face sends the
  SHA-256 in a header; other files are hashed by `scripts/make-manifest.ts`), so a wrong URL cannot pass.
- **One server at a time, started on demand, stopped when idle.** The desktop starts llama.cpp, whisper.cpp
  or the OCR server as a child process bound to localhost (`sidecar_start`), a `Keeper` serialises calls (an
  8 GB laptop cannot run two generations at once) and stops the server five minutes after the last call. The
  servers come from a runtime bundle in the manifest, unpacked by the desktop.
- **OCR has a fallback, and the fallback is the one that works today.** The sidecar OCR engine (a dedicated
  model with Devanagari and Tamil) is specified by its HTTP contract and has a client, but there is no built
  binary for it yet (B-149). Tesseract runs in the page with language files from the model manager, seeded
  into its IndexedDB cache so nothing is fetched. Images are cleaned first (grey, median denoise, Otsu
  threshold, skew found by row-profile variance, crop to the ink); PDFs are rasterised with pdf.js.
- **Vectors live in the database.** `hsn_embeddings` holds one vector per code and model; the hybrid lookup
  scales BM25 and cosine scores to 0..1 and sums them, so a misspelt query still finds its code and a code found
  both ways comes first. The hashed-trigram embedder needs no model and handles spelling; a real embedding
  model (nomic, bge) replaces it when downloaded and the index is rebuilt.
- **Voice is push-to-talk and never acts alone.** The recording becomes 16 kHz WAV, whisper transcribes, the
  sentence is parsed, and a dialog shows the party, lines and amount for confirmation; "Open as a draft" hands
  the result to the editor through session storage, where the party and items are looked up by name and
  anything unknown stays as the words said. The same dialog accepts a typed sentence, which is how a machine
  without a microphone (and the e2e suite) uses it.
- **Regional drafts keep their facts.** A rephrased reminder is kept only if every number, amount and name of the
  template survived (`paraphraseKeepsFacts`); otherwise the template is used. The person edits before sending.
- **Privacy.** Nothing is sent anywhere. The only record is the `ai_calls` row per attempt (feature, provider,
  model, tokens, latency, outcome), never a prompt or an answer. OCR text is kept in the review item's payload
  (capped) so the card can show what was read; the audit trail does not carry it.

## Consequences

- The desktop glue (`src-tauri/src/ai.rs`: model files, hardware, sidecars) is behind the `ai` cargo
  feature and has not been compiled on a real machine (B-150). The pure parts are tested: the manager's
  resume, pause and hash checks, the grammar, the keeper, the sidecar protocol against an in-process fake
  llama.cpp, the preprocessing on synthetic pages, extraction on 63 bills, matching, the pipeline end to end,
  eight spoken sentences, the drafting guard, and the vectors on both database dialects.
- No model has been run here, so the prompt's accuracy criterion (80% on clean printed bills with the
  recommended model on the baseline device, 20 CA-checked bills) is open (B-151, B-152). The eval CLI can
  score a running llama.cpp or Ollama; the doc says how.
- Qwen2.5 3B is under the Qwen Research License; the manifest says so and the person must accept it. The
  1.5B and 7B are Apache-2.0, Whisper and bge are MIT, tessdata is Apache-2.0.
- WebLLM in the PWA is wired but unverified (needs WebGPU and a model download WebLLM manages itself).
- The GBNF grammar emits optional keys as nullable, always present; a schema with a regex string is enforced
  only by the check after generation.
