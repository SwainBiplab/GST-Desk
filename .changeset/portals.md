---
'@gst/ai': minor
'@gst/i18n': minor
'api': minor
'web': minor
---

Sharing with an accountant, and the customer's pages (prompt 47). An owner shares one business read-only with an
accountant for a financial year or a span of dates (read, GST, exports, comments), revocable at any time; the
accountant accepts on their own sign-in and reads the client through the new Clients page: filing cells, what is
waiting, documents inside the shared dates with their PDFs, comments that land in the owner's inbox, and an export
pack (registers, GSTR files, Tally XML, statements, PDFs) built as a job with a download link. A share is enforced
server-side as a narrowed, view-only membership under the client's row-level security; the Filing board includes
shared businesses. A customer link opens one invoice or one statement on a public page with the amount owed, a Pay
button through the business's gateway, the PDF and a question for the owner's inbox; tokens are 128-bit random,
stored as hashes, rate limited, expiring and revocable, and the pages can be turned off per business.
