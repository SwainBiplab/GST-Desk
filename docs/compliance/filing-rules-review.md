# Filing rules for review: late fee, nil return, QRMP

For the chartered accountant's sign-off (B-202). Source: `packages/domain/src/gstr/filing-rules.ts`, version
`late-fee-v1 (unreviewed)`. Nothing here has been checked against the notifications in force; the figures were typed from
the CGST Act s.47 and the notifications that reduce the fee, and the screen calls them an estimate.

| Item             | What the code does                                                                                                                         | To confirm                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Late fee per day | Rs 50 (25 CGST + 25 SGST); Rs 20 for a nil return                                                                                          | Rates in force for GSTR-1 and GSTR-3B; whether IGST-only or other cases differ      |
| Cap              | Nil Rs 500; turnover up to Rs 1.5 crore Rs 2,000; up to Rs 5 crore Rs 5,000; above Rs 5 crore Rs 10,000; unknown turnover uses the highest | The bands and amounts for each return, and whether the cap is per return or per Act |
| Turnover used    | The previous financial year's aggregate turnover from the books                                                                            | Whether the portal's aggregate turnover differs                                     |
| Interest on tax  | Not estimated                                                                                                                              | Add as a separate figure                                                            |
| Days             | Whole calendar days after the due date, to the filing date or today                                                                        | Whether the first day counts                                                        |
| Nil GSTR-1       | A file with the GSTIN, period and a nil flag                                                                                               | The portal's real nil-return call and file                                          |
| IFF              | Months 1 and 2 of a quarter, due the 13th of the next month; B2B and credit/debit notes only; Rs 50 lakh a month                           | Limit, tables and due date                                                          |
| Due dates        | From `DUE_DATE_RULES_V1` (unchanged by this prompt)                                                                                        | Extensions notified for the period                                                  |
