---
'@gst/domain': minor
'@gst/db': minor
'web': minor
---

Reports and question-led dashboards. Fourteen reports (sales, purchase and note registers, party outstanding with ageing, receivables and payables, GST summary by rate, HSN summary, documents issued, expense summary, receipts and payments with cash and bank books, day book, stock summary, party-wise and item-wise sales) on one report page with period presets in the Indian financial year, party, type and side filters, grouping with subtotals, a column chooser, saved views, formula-safe CSV and Excel export of every row, and print. The Shop and Books dashboards answer their questions with numbers that each open the matching report. Turnover and purchase rules now come from one list in the domain package, and tests hold the sales register, GST summary, HSN summary and ledger sales to the same total on the seed. First pages render under 0.6 s and a 29,000-row export takes about 1.4 s on a 50,000-document book. The dashboards also draw sales and spend by month, money in and out, receivables by age, the last 14 days of sales and the top customers as charts, each with a hover tooltip, a table view and a click through to its report.
