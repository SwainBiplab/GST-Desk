# Runbook: offline AI

## Turn it on

Settings, AI. Choose a backend: _Rules only_ (the default; nothing to download), _Offline models on this
computer_ (desktop; download a text model, a speech model and OCR language files below), _Ollama on this
computer_ (point it at a running Ollama and pick a model), or _In this browser_ (WebGPU, PWA only).

Download: each model shows its size and licence; press _Licence and download_, read, accept. A download can be
paused and resumed, survives a restart, and is checked against its hash before it is called ready. Then choose
which ready model to use for text, vectors, speech and OCR.

## Scan a bill

Inbox, _Scan a bill_ (or the command bar: "scan"). Choose a photo or PDF, or drop files, or on a phone take a
photo. The card shows the scan beside the fields with a confidence per field, the lines, and whether the totals
add up. _Edit_ to fix fields, choose the supplier and match items; _Accept_ makes a purchase draft with the scan
attached, which you issue from the editor. Desktop: a watched folder (Settings, AI) is scanned every quarter minute.

## Speak a bill

Hold the _Talk_ button (command bar, or the shop screen) and say it: "Ramesh ko do bori cement teen sau pachas
rupaye". Let go; check what was understood; _Open as a draft_. No microphone: _Type_ the sentence instead.

## When it does not work

| Symptom                            | Likely cause                                                    | Do this                                                                       |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| "No text reader is set up"         | No OCR language file downloaded                                 | Settings, AI: download _OCR: English_ (and Hindi)                             |
| The model list is empty or refused | Wrong manifest URL, or a signature that does not match          | Reload with the default list; a custom list must be signed with the app's key |
| Download stops at the same byte    | The server does not support ranges                              | Delete and start again; the app restarts from zero when a range is ignored    |
| "could not start llama-server"     | No runtime bundle for this platform                             | Use Ollama (B-150)                                                            |
| Bill read with wrong rates         | The bill prints no rate per line                                | Match the lines to catalogue items; the item's rate takes over                |
| Totals differ                      | OCR misread a number, or a discount the extractor does not know | Fix the line in _Edit_; the engine recomputes                                 |
| Voice gives "No speech model"      | No whisper model chosen                                         | Download _Whisper base_ and choose it, or type                                |

## Before relying on it

`apps/desktop/src-tauri/src/ai.rs` has not been compiled on a real machine. Build with
`cargo tauri build --features ai`, then: download the English OCR file and scan a printed bill; download
Qwen 1.5B and a runtime bundle and scan again (the card should say "Read by local-llama"); hold the Talk button
and speak; check `ai_calls` shows the attempts and nothing else. Record the eval numbers in
`docs/ai/eval-results.md`.
