# @gst/domain

Pure TypeScript money engine: GST computation, document totals, numbering, turnover rules and ledger
posting. No I/O, no UI, no clock (inject one). Money is integer paise in `bigint`; quantities are integer
micro-units; rates are basis points. Every calculation returns `{ result, trace }`.

## Functions and the rules behind them

| Function                                                                                                      | Rule                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `supplyType`, `taxHeadsFor` (`tax/supply.ts`)                                                                 | IGST Act s.7, 8, 10-13 (place of supply); CGST s.8-9 and UTGST Act s.7-8 (heads); IGST Act s.16 (zero rating: export, SEZ, LUT) |
| `priceLine`, `computeLine` (`tax/line.ts`)                                                                    | CGST s.15 (value of supply, discounts), s.9(3)/(4) (reverse charge), s.10 (composition); Compensation Cess Act s.8              |
| `computeDocument` (`tax/document.ts`)                                                                         | CGST s.15(3) (invoice-level discount, allocated pro rata), s.34 (credit notes); round-off to nearest rupee                      |
| TCS inside `computeDocument`                                                                                  | Income-tax Act s.206C(1H); omitted by the Finance Act 2025 for receipts on or after 1 Apr 2025 (`TCS_206C1H_SUNSET`)            |
| TDS inside `computeDocument`                                                                                  | Income-tax Act s.194Q; when the buyer deducts it the seller collects no TCS                                                     |
| `formatDocumentNumber`, `takeNext`, `reserve`/`consume`/`release` (`numbering.ts`)                            | Rule 46(b) CGST Rules: max 16 characters, `A-Z a-z 0-9 - /`                                                                     |
| `turnoverSign`, `purchaseSign`, `netTurnoverPaise`, `TURNOVER_PLUS` and friends, `gstr1Table` (`turnover.ts`) | GSTR-1 tables 4, 5, 7, 8, 9B; B2CL threshold Rs 1 lakh from 1 Aug 2024 (Rs 2.5 lakh before)                                     |
| `postDocument`, `postPayment` (`ledger/posting.ts`)                                                           | Double entry; output tax by head; RCM self-assessment                                                                           |
| `amountToWordsEn/Hi` (`words.ts`)                                                                             | Indian grouping (thousand, lakh, crore)                                                                                         |
| `fyOf`, `financialYear`, `today` (`fy.ts`)                                                                    | Financial year 1 April to 31 March (configurable start month), IST                                                              |

## Items, units, CSV and the HSN master (prompt 13)

| Module          | What it holds                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `item.ts`       | `validateItemInput` (the one definition of a valid item, used by form, import and repository), `itemWarnings`, `GST_RATES_BP`.                                                               |
| `barcode.ts`    | `gtinCheckDigit`, `validateBarcode` (EAN-8, UPC-A, EAN-13, GTIN-14 with check digit; other codes are custom).                                                                                |
| `units.ts`      | `UQC_MASTER`, `returnsUqc`, `validateCustomUnit`, `toPrimaryMicros` / `toSecondaryMicros` for a second unit.                                                                                 |
| `bulk-edit.ts`  | `planBulkEdit`: what each item becomes under a GST rate, price (percent or amount) or tag change, with integer arithmetic.                                                                   |
| `csv.ts`        | `parseCsv` (BOM, quotes, `, ; tab \|`, line numbers), `toCsv` and `csvCell` (formula escaping), `parseAmountPaise` / `parseRateBp` / `parseQtyMicros` (Indian grouping, no silent rounding). |
| `import-map.ts` | `detectMapping`, saved mappings by header text, `ITEM_FIELDS` and `PARTY_FIELDS`.                                                                                                            |
| `hsn.ts`        | `parseHsnCsv`, `planHsnImport` (rate history), `rowAsOf`, `verifyHsnManifest` (Ed25519 over the file hash), `compareVersions`.                                                               |
| `data/`         | Signed HSN versions built by `tools/hsn`, the public key, and `bundled.ts` (generated).                                                                                                      |

## Conventions worth knowing

- **Rounding:** half away from zero, one rounding step per figure (`divRound`). CGST and SGST are rounded separately from `taxable x rate / 2`, so they are always equal.
- **Tax-inclusive prices:** taxable is backed out of the (discounted) inclusive price, then tax is added back. The line total can differ from the entered price by a paisa or two; the document round-off absorbs it.
- **Reverse charge:** tax is computed and reported (`rcmTaxPaise`) but is not part of the line or document total.
- **Document total** = sum of line totals + TCS + round-off. TDS is informational (`tdsPaise`, `netReceivablePaise`).
- **Rates** such as 0.25% split into 0.125% heads, which is fine for amounts but cannot be stored in an integer basis-point column.

## Golden vectors (`test/vectors/`)

203 cases. `hand.json` was computed by hand from the rules; the rest come from `scripts/gen-vectors.ts`, an independent oracle that shares no code with `src/` and uses a seeded PRNG. Regenerate with `pnpm --filter @gst/domain vectors`.

| File                                             | Cases  | Covers                                                                                                                                        |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `hand.json`                                      | 35     | basics, rounding, discounts, inclusive, UTGST, cess, composition, exempt, SEZ, export, RCM, invoice discount, round-off, TCS/TDS, credit note |
| `gen-intra.json`, `gen-inter.json`               | 20, 15 | CGST+SGST, IGST over random lines                                                                                                             |
| `gen-utgst.json`                                 | 10     | UT without legislature                                                                                                                        |
| `gen-cess.json`                                  | 12     | ad valorem and specific cess                                                                                                                  |
| `gen-composition.json`, `gen-exempt.json`        | 6, 9   | no tax collected                                                                                                                              |
| `gen-sez.json`, `gen-export.json`                | 8, 8   | with and without LUT                                                                                                                          |
| `gen-rcm.json`                                   | 8      | reverse charge                                                                                                                                |
| `gen-inclusive.json`                             | 12     | tax-inclusive, with per-unit and percent discount                                                                                             |
| `gen-discount.json`, `gen-invoice_discount.json` | 12, 14 | line and invoice discounts across mixed rates                                                                                                 |
| `gen-round_off.json`                             | 10     | round-off up and down                                                                                                                         |
| `gen-tcs.json`, `gen-tds.json`                   | 10, 8  | threshold crossing, sunset, mutual exclusion                                                                                                  |
| `gen-credit_note.json`                           | 6      | partial reversals                                                                                                                             |

## Tests

`pnpm --filter @gst/domain test` runs vectors, fast-check properties (totals add up, CGST = SGST intra, IGST only inter, discount allocation exact, ledger balances), numbering edge cases, a 500-line performance check and a guard test that greps `src/` for `Number(` or `Math.round` on paise. `pnpm --filter @gst/domain test:coverage` enforces 95% lines.

## Series, period lock and cancellation rules (prompt 15)

`series.ts` holds the pure rules behind numbering settings and after-issue changes: `validateSeries` and `previewSeries` (GST character set, worst-case 16-character width with each `{FY}`, `{YYYY}`, `{MM}` token at its widest), `seriesClash`, `provisionalNumber`, `isLockedDate`, `classifyEdit` (which fields can change after issue without a new revision), `reverseEntries` and `cancelBlocker`. The repositories in `@gst/db` apply them; see `docs/compliance/numbering-and-cancellation.md`.

## Reports (prompt 18)

`reports.ts`: `resolvePeriod` and `PERIOD_PRESETS` (today, this and last month, this and last quarter, this and last financial year, in the business's financial-year start month), `presetOf`, `sameDaysLastMonth`, ageing (`ageingBucket`, `ageInto`, `daysPastDue`: not yet due, 1 to 30, 31 to 60, 61 to 90, over 90) and `filingCalendar` (the usual GSTR-1 and GSTR-3B dates for monthly filers). Tests: `test/reports.test.ts`.
