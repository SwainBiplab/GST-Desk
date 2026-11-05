# e-Invoice and e-way bill (web)

The screens for prompt 32 (ADR 0018). The rules live in `@gst/domain` (`src/einvoice/`), the queue and records in `@gst/db` (`EinvoiceRepo`), the vendor adapters in `@gst/gsp`. This folder is only the screens and the session.

| File                | What it does                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.ts`        | Unlocked credentials (memory only), the practice portal's memory (`localStorage`), and `clientFor` which builds the `GspClient` that logs through `EinvoiceRepo.writeLog` |
| `jobs.tsx`          | `GspJobs`, mounted in the root: drains the queue on open, when a request is added, when the network returns, on unlock, and every minute                                  |
| `panel.tsx`         | The document's e-Invoice tab: check, generate, QR, cancel within 24 h, and the e-way bill (generate, change vehicle, extend, cancel)                                      |
| `einvoice-page.tsx` | The page (GST section of Books): "Waiting for IRN" with bulk generation, and the e-way bill list with a countdown                                                         |
| `portal-tab.tsx`    | Settings, GST portal: e-invoicing on or off, GSP mode and address, sealed logins and the PIN                                                                              |
| `model.ts`          | What the screens show, worked out from the rows (no React; unit tested)                                                                                                   |
| `hooks.ts`          | Live queries                                                                                                                                                              |

## Things to know

- Nothing is sent while the credentials are locked; requests wait in the queue with their attempts kept.
- With no GSP configured the app is in **practice** mode: the practice portal issues IRNs that are not real, and every panel says so.
- The editor re-reads an issued document when its e-invoice row changes (`useEditor().refresh`), so a cancellation or an IRN made by the queue shows without a reload.
- End-to-end tests (`e2e/einvoice.spec.ts`) fix the clock, so the 24-hour and 8-hour windows are exact.
