# PDF rendering matrix (manual)

The automated tests prove the PDF is valid, small (under 150 KB for one page), deterministic, that its text can be extracted back out, and that its layout equals the preview's (they are the same layout). They cannot prove how each viewer draws it. Before a release, open the same five PDFs in each viewer below and tick the box when it matches the preview.

How to make the five: in Settings → Print, for each template (Classic, Modern, Compact, Tally-like, Retail) use the demo business, open an invoice with 3 lines, More → Download PDF. Also make one 60-line invoice (pagination), one in Hindi and one in Tamil (shaped text), one cancelled, and one with a logo and a UPI QR.

| Check                                                                          | Chrome | Edge | Adobe Reader | WhatsApp preview | Android viewer | iOS Files |
| ------------------------------------------------------------------------------ | ------ | ---- | ------------ | ---------------- | -------------- | --------- |
| Text is selectable and searchable (search for the invoice number)              | [ ]    | [ ]  | [ ]          | n/a              | [ ]            | [ ]       |
| Fonts look the same as the preview; the rupee sign shows as a rupee sign       | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| Columns line up; amounts are right-aligned; no text runs over a neighbour      | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| Page breaks: no line split, totals block whole, "continued", "Page x of y"     | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| Hindi labels: conjuncts (क्ष, त्र, श्र) and vowel signs sit correctly          | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| Tamil, Bengali, Gujarati labels: no boxes, vowel signs on the right letters    | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| The UPI QR scans with a payment app, and shows the right payee and amount      | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| Logo is sharp and not stretched                                                | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| CANCELLED stamp is visible and the text under it is still readable             | [ ]    | [ ]  | [ ]          | [ ]              | [ ]            | [ ]       |
| Printing on paper (A4, A5, Letter) matches the screen; margins are not clipped | [ ]    | [ ]  | [ ]          | n/a              | n/a            | n/a       |

## Thermal

| Check                                                                             | 58 mm | 80 mm |
| --------------------------------------------------------------------------------- | ----- | ----- |
| Every line fits the roll with no wrapping of the amounts column                   | [ ]   | [ ]   |
| The total is bold and large; the QR scans                                         | [ ]   | [ ]   |
| A Hindi receipt (bitmap lines) is legible and not cut off                         | [ ]   | [ ]   |
| The paper is cut after the last line; the cash drawer opens when the option is on | [ ]   | [ ]   |

## Known

- Diacritic marks in Indic scripts are placed by the font's advance widths and glyph substitution, not by GPOS mark anchors. If a mark sits visibly off, note the script and the viewer here and in backlog B-035.
- WhatsApp's preview shows the first page only.
