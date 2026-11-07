---
'@gst/ai': minor
'@gst/db': minor
'web': minor
---

Tier 1 local AI. Scan a purchase bill (photo or PDF): the image is cleaned, read by OCR, the fields found by rules and, when a model is on, by the model too; the supplier and lines are matched to the books, the engine checks the total, and the result is an inbox card with the scan beside the fields and a confidence per field. Accepting makes a purchase draft with the scan attached. A model manager under Settings, AI downloads from a signed manifest (size, hash and licence per model, pause and resume, delete, disk use), with llama.cpp, Ollama and WebLLM backends behind JSON grammars. Semantic HSN search merges BM25 with vectors stored in `hsn_embeddings`. Push-to-talk (or a typed sentence) in Hindi, Hinglish, Tamil, Marathi or English becomes a confirmed draft. Reminder rephrasing keeps every number and name or falls back to the template. The eval CLI scores a provider per field on 60 synthetic bills (rules alone: 90.1%). The desktop glue for model files and sidecars is behind the `ai` cargo feature and unverified (B-150).
