# Direct tax (prompt 33)

TDS and TCS, challans, the quarterly statements (26Q, 27EQ), data for Form 16A and 27D, the register of tax customers deducted, and an income-tax estimate for a proprietor. Route `/books/directtax` (page id `directtax`).

- `hooks.ts`: live queries and the actions that call `DirectTaxRepo` from `@gst/db`.
- `deduct-tab.tsx`: suggestions from issued purchase bills and sales, what is recorded, and a form for a deduction by hand.
- `challan-tab.tsx`: challans and the matching of deductions to them.
- `returns-tab.tsx`: a quarter's statement, its problems, CSV and Excel downloads, certificate data.
- `receivable-tab.tsx`: tax customers deducted from payments to us, with the certificate status.
- `income-tab.tsx`: inputs kept per business and year, both regimes, advance tax and interest. Prints with the browser's print dialog.
- `model.ts`: the Excel annexure and the conversion of the form into the engine's input.

The arithmetic is in `packages/domain/src/direct-tax/`; the rates are in `packages/domain/data/direct-tax.json`. Party fields (PAN, section, certificate) are on the party form.

Tables written: `tax_deductions`, `tax_challans`, `tds_receivable`; settings key `incometax.<fy>`.

Not covered: filing a return, ITR JSON, sections other than 194C, 194J, 194H, 194I, 194Q and the 206C sections in the data. See `docs/compliance/direct-tax-review.md`.
