# GSTN layouts and due dates

Everything the GSTR-1 and GSTR-3B builders need to know about the **government's file format** lives here as data, so a format change never touches the builders (`src/gstr/gstr1.ts`, `gstr3b.ts`).

| File           | What it holds                                                                              |
| -------------- | ------------------------------------------------------------------------------------------ |
| `v1.ts`        | Key codes, enums, the B2CL limit and the period and date formats of the offline-tool JSON. |
| `due-dates.ts` | The standard due-date rules for monthly and quarterly (QRMP) filers.                       |

## Status: not verified

The GST Network does not publish a downloadable schema for these files. `v1.ts` is reconstructed from the layout documented for the offline tool and returns, and says `verified: false`. **Nothing here has been checked against the real offline tool yet.** The compliance reviewer must load a seeded-month export into the offline tool and record the result in `docs/compliance/gstr-review.md`. Until that is done, do not file with these exports.

## Adding a version

1. Copy `v1.ts` to `v2.ts`, rename the export (`GSTN_V2`) and set `version: 'v2'`, `verified: false`.
2. Change only what the new layout changes (a key name, a code, a limit).
3. Register it in `src/gstr/json.ts` (`SCHEMAS`), and make it the default there when it takes effect.
4. If a table's _shape_ changed (not just a key), add a small adapter function for that table next to the existing one in `json.ts`; the table builders output the same typed objects for every version.
5. Add a golden fixture under `test/gstr/fixtures/` for the new version and run `pnpm --filter @gst/domain test`.
6. Set `verified: true` only after a reviewer has opened an export in the offline tool, and say who and when in `docs/compliance/gstr-review.md`.

## Due dates

The rules are the law's defaults. The government often extends a particular month's date by notification; those extensions are not in the data. Businesses can override a date from Settings and the Filing Desk marks overrides.
