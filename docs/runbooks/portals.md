# Runbook: sharing with an accountant and the customer pages

1. Set `PORTAL_URL` on the API to where the web app is served (a customer link is `${PORTAL_URL}/p/<token>`). Without
   it the first `http(s)` origin in `TRUSTED_ORIGINS` is used. The web app reads the API from its build (`VITE_API_URL`),
   from `?api=` on the link, or from its own origin. `SECRETS_KEY` lets owners copy a link again later; without it a
   link is shown once. `RATE_LIMIT_PORTAL_PER_MINUTE` (default 60) is the public pages' limit per address and per token.
2. Sharing: an owner (team create) opens Settings, Accountant and customers, enters the accountant's e-mail or number,
   the financial year (`2026-27`) or dates, and the switches. The accountant signs in with that address and accepts on
   the Clients page within 14 days. Revoke from the same tab; access ends on their next request.
3. An accountant who "cannot see" a client: check the share is `active` (not `pending`, `revoked` or `declined`), its
   `expires_at`, and that they signed in with the invited address. A `403` on a route says the share does not cover it
   (writes, the team, another business, a period outside the dates); a `404` on the organisation says there is no live
   share.
4. Customer pages are off until the owner turns them on (Settings, Accountant and customers). A link made while they are
   off is dark (`410`) until they are on. Statements have their own switch, and so do questions.
5. A customer who reports the link "does not exist" has a wrong or mistyped address (`404`); "no longer available"
   means it expired, was withdrawn, or the pages are off (`410`). Make a new link from the document's More menu.
6. Paying from the page needs the business's gateway (prompt 45). `503` on Pay means no gateway; `409` means nothing is
   owed. The webhook marks the invoice paid as for any other link.
7. Export packs need object storage (`503 pack_no_storage` otherwise) and run on the `pdf` queue. A `failed` pack keeps
   its error on the row; the ZIP expires from `tmp/` after seven days, after which Download says to ask for a new one.
8. Questions and comments are inbox cards (`portal_question`, `ca_comment`) on the owner's devices; they are
   acknowledged like any other card.
9. Never put a token, a link or a customer's contact in a ticket; use the link id and the business.
