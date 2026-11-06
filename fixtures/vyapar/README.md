# Vyapar sample files

**These files are synthetic.** They were written to look like the Excel and CSV reports Vyapar exports (a parties list, an items list, a sales report with one row per item), using the column headings the importer expects. They are not real exports and contain no real names, GSTINs or amounts. The prompt asked for anonymised real exports; none was available when this was written (backlog B-135). Until real ones are added, a successful run on these proves the importer is consistent with itself, not that it reads a real Vyapar file.

| File                  | What it is                                                                  |
| --------------------- | --------------------------------------------------------------------------- |
| `parties.csv`         | A parties report: name, GSTIN, phone, state, city, opening balance          |
| `items.csv`           | An items report: name, HSN, unit, selling and purchase price, GST percent   |
| `sales-items.csv`     | A sales report with one row per item, with discount percent and tax percent |
| `purchases-items.csv` | The same layout for purchases                                               |
