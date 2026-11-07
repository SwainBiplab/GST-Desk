# GST corpus for Q&A with citations

Curated, plain-English summaries of the provisions GST Desk's assistant may cite (prompt 48). Each file has front
matter (`title`, `source`, `date`) and headings; `pnpm --filter @gst/ai ai:corpus` chunks and indexes them into
`packages/ai/data/gst-corpus.json`, which the cloud gateway searches for a question and hands to the model as
documents with citations on. The answer always shows its sources and the not-legal-advice line.

These are summaries written from the Act, the Rules and the notifications as they stood on the date in each file,
not the text of the law. Before a release a chartered accountant reviews them (B-215), and a change in the law is
a change here: edit the file, bump its `date`, rebuild the index.
