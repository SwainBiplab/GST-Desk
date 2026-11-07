# 0025 — Roles, permissions and approvals

Status: accepted. Context: prompt 42, PRD FR-131, FR-042, NFR-06.

## Decision

- **One matrix, shared.** `packages/domain/src/permissions.ts` defines modules (customers and suppliers,
  items, stock, sales, notes, quotes, purchases, payments, reports, GST, settings, team, audit) and actions
  (view, create, edit, issue, cancel, export, approve). Documents are split by kind so a counter can raise
  invoices without touching purchases. The app reads the matrix to hide or disable what a person cannot
  do; the API and the sync write path read the same matrix to refuse it. Nothing in the app is the only
  guard.
- **Built-in roles**: owner, admin, accountant (reads and exports everything, does the GST work: the
  "accountant" invite preset), sales (a counter: customers, sales, quotes, receipts), inventory (items,
  stock, purchases), viewer. **Custom roles** per organisation are grants over the same matrix
  (`org_roles`); a member holding one keeps `viewer` on better-auth's row, so a lost link fails closed.
- **No way up.** Only an owner touches an owner or makes one. Anyone else needs `team.edit` and cannot hand
  out (by invitation, role change or a custom role) more than they hold. The last owner cannot step down or
  leave. better-auth's own organisation endpoints are closed; the team routes are the only way in.
- **Fresh on every request.** The API resolves a member's permissions per request, so a role change or a
  removal holds from the next call; removal also stops the member's devices (`sync_devices.revoked_at`).
  The app re-reads its copy every 30 seconds and remembers the last answer per organisation for offline
  work; a synced book never assumes it is owned (read-only until the first answer).
- **Sync writes** are authorised as a whole transaction before anything is written: documents by kind and
  by what happens to them (create, edit, issue, cancel), payments likewise, other tables by module. Rows
  that only follow from a document or payment (ledger postings, stock movements, allocations) pass with it.
  Server-owned tables (memberships, devices, the HSN master) never come from a device.
- **Approvals (optional per organisation).** With the policy on, a cancellation or a revision of an issued
  document, or a cancelled payment, by someone without `approve` is held: nothing is applied, the device gets
  the server's version back, and an `approval_request` inbox item carries the whole transaction. An approver
  (owner or admin by default) approves through the API: the transaction is applied as the person who asked,
  with their permissions checked again at that moment, and the approval is on the audit trail. A change that
  raced it becomes a sync conflict instead. Nobody approves their own request.
- **Audit.** The trail shows people by name (team members) and system processes by what they are, a
  per-person summary (changes, first and last), sign-in history from the API (own sign-ins for anyone,
  everyone's for those who read the audit trail), and the export carries names and ids.

## Consequences

- LAN tablets (prompt 35) map their pairing roles onto the same matrix (`full` admin, `counter` sales, `view`
  viewer); the browser does not run the tablet client yet, so nothing feeds that mapping today.
- A removed member's device may keep downloading for up to five minutes (the PowerSync token's lifetime,
  now 5 minutes instead of an hour); every upload and API call is refused at once. Within 60 seconds for
  downloads would need the service to drop streams on revocation (B-175).
- The browser's synced books need the sync client (B-167) before the permission poller has a synced book to
  follow on the web; the poller is tested against the store and the API is tested against Postgres.
