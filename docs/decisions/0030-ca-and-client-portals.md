# 0030 — Sharing with an accountant, and the customer's pages

Status: accepted. Context: prompt 47, PRD FR-160 to FR-162, cloud tier.

## Decision

- **A share is a membership-shaped grant, narrowed.** An owner shares one business with an address (or a phone number,
  addressed to the e-mail a phone sign-in gets) for a financial year or a span of dates, with four switches: read the
  books, the GST module, exports, comments. The accountant accepts after signing in with that address (an invitation
  lasts 14 days). `shareAccessOf` turns an active share into the same `Membership` value the routes already check,
  with view-only grants built from the switches, plus a `share` that names the business and the dates. `requireOrg`
  falls back to it when the caller is not a member, and then narrows: only the client routes, the business and
  permission lookups and the filing desk's reads may be called; any `businessId` named must be the shared one; any
  return period must lie inside the dates. Every read runs under the client's organisation with row-level security,
  as a member's would. Sync reads memberships directly and never sees a share, so a share cannot download a book.
  Revoking is a status change read on the next request.
- **The only write is a comment**, a `review_items` row of kind `ca_comment` that syncs to the owner's devices like
  every other inbox card. The accountant's name is on it; a document outside the dates cannot be commented on.
- **The customer's link is the credential.** A link names one issued document or one party's statement. The token is
  16 bytes from the system's random source in base64url; only its SHA-256 is stored and matched, and the organisation
  is the only thing the match yields before the row is read under that organisation. The token is kept sealed under
  the platform key (`SECRETS_KEY`, bound to the organisation) only so the owner can copy a link again; without the key
  a link is shown once. The page carries the business, the document and its payment state, and never an id of ours.
  Unknown, malformed and nearby tokens all answer the same "not found"; revoked and expired links, and links of a
  business whose pages are off, answer "gone". The public routes are rate limited per address and per token on top of
  the API's own limit, send `no-store` and `noindex`, and carry no session.
- **Paying from the page** reuses prompt 45: the live payment link if the business already made one, otherwise one is
  made for what is owed (by `portal`), and the gateway's webhook marks the invoice paid as before. A question or dispute
  from the page is a `portal_question` inbox card, one per link and text.
- **The export pack is a job** on the `pdf` queue (run inline when there is no queue): the sales, purchase and note
  registers, the GST and HSN summaries, GSTR-1 and GSTR-3B files for every month of the span with the problems standing
  against each (the pack does not gate on them: the accountant wants to see them), Tally masters and vouchers, the party
  statements and balances, and up to 300 PDFs. It is uploaded through the same signed PUT the apps use into the
  organisation's `tmp` prefix, which the bucket's lifecycle removes after seven days; the answer is a ten-minute signed
  address. Without object storage the request is refused up front.
- **The web app's Clients page** is the accountant's side: shares to accept, every client with its filing cells (the
  Filing board now includes shared businesses too), what is waiting and when the books last synced, and one client
  opened read-only over the cloud API. It is not the local Books shell over a synced copy: web and desktop have no sync
  client yet (B-208), so the client's books are read through the API and the PDFs rendered on the server.

## Consequences

- An accountant needs no membership, and an owner needs no team seat for them; the share is the whole relationship,
  and it ends when the owner says so or the dates do.
- A customer's page is public by design: anyone holding the address sees that one document. Links expire (90 days by
  default, settable per business) and can be withdrawn; the page says when it expires.
- The business logo is not on the customer's page or the server-made PDF: logo bytes live in the device's file store
  and are not in the cloud tier yet (B-209).

## Verified

`apps/api/test/portals.test.ts` (Postgres and MinIO): invite, accept, what a share can and cannot reach (writes, the
team, sync, other businesses, periods outside the dates), revoke and expiry, the board and client list, comments, the
export pack's contents and download, and the public links: the token space (every one-character neighbour of a live
token and 200 random tokens answer "not found" alike, the stored form is the hash), PDF, pay through the mock gateway
and paid after the webhook, questions once, statements, revoke, expiry, the portal switch, the rate limit.
`apps/web/e2e/portals.spec.ts`: the owner shares and makes a link, the accountant accepts and reads and comments and
takes a pack, the customer opens the page, pays (mock), downloads and asks.
