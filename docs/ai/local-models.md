# Offline models: manifest, licences, bundles

## The manifest

`apps/web/public/ai/models.json` (a copy of `packages/ai/data/models.json`) is what Settings, AI reads.
It is signed: the app verifies the Ed25519 signature against `packages/ai/data/model-signing-key.json`
before offering anything, so a tampered server cannot point the app at a different file. Fields per model:
`id`, `kind` (`llm`, `embedding`, `whisper`, `ocr`, `ocr-lang`, `runtime`), `file`, `url`, `sizeBytes`,
`sha256`, `licence` (name, url, summary shown before download), `minRamGb`, `platforms`, `languages`, `notes`.
`bundles` name the ids for each device class (`minimal` under 6 GB, `baseline` 8 GB, `capable` 16 GB or a
GPU, `strong` 32 GB with a GPU); the app drops what will not fit.

## Building it

```
pnpm --filter @gst/ai exec tsx scripts/make-manifest.ts [--key private.json] [--out models.json]
```

reads `packages/ai/data/models.source.json`, asks each host for the size and hash (Hugging Face answers
`x-linked-size` and `x-linked-etag`; anything else is downloaded and hashed), signs, verifies with the public
key, and writes both copies. **The development private key is in the repository**
(`model-signing-key.dev-private.json`) so the manifest can be rebuilt by anyone; a release must sign with a key
kept outside, and ship its public half in `model-signing-key.json` (B-153).

A person can point the app at another manifest (Settings, AI, Model list): only https or localhost, and it must
be signed with the same key.

## Models in the list and their licences

| id                                                         | kind      | licence                                                  | notes                                   |
| ---------------------------------------------------------- | --------- | -------------------------------------------------------- | --------------------------------------- |
| qwen2.5-1.5b-instruct-q4                                   | llm       | Apache-2.0                                               | baseline; bills and speech on 8 GB      |
| qwen2.5-3b-instruct-q4                                     | llm       | Qwen Research License (non-commercial without a licence) | capable                                 |
| qwen2.5-7b-instruct-q4                                     | llm       | Apache-2.0                                               | strong                                  |
| nomic-embed-text-v1.5-q8                                   | embedding | Apache-2.0                                               | HSN vectors                             |
| bge-small-en-v1.5-q8                                       | embedding | MIT                                                      | HSN vectors, small                      |
| whisper-base, whisper-small                                | whisper   | MIT                                                      | speech, multilingual                    |
| tess-eng, tess-hin, tess-mar, tess-tam, tess-ben, tess-guj | ocr-lang  | Apache-2.0                                               | Tesseract language data (tessdata_fast) |

Not in the list yet: the llama.cpp and whisper.cpp runtime bundles per platform (`runtime` entries, B-150)
and the OCR sidecar model (B-149). Until a runtime bundle is listed, the built-in backend cannot start a
server; Ollama is the way to use a local model today.

## Where files go

Desktop: `<data folder>/models/` (the data folder from Settings, Desktop), state in `models-state.json`.
Browser: the private file system (`gst-models`), used for OCR language data. A partial download is
`<file>.part` and resumes.
