# features/team

Roles and permissions in the app (prompt 42). The matrix itself is `@gst/domain` (`permissions.ts`), shared
with the API.

- `permissions.ts`: the store of what the person at this screen may do (`usePermissions`, `useCan`), where
  it comes from (a local book's owner, the cloud API polled every 30 s for a synced book, a LAN tablet's
  role), and `pageAllowed` for the nav and the command bar.
- `source.tsx`: picks the source for the open book; mounted at the root.
- `team-tab.tsx`: Settings, Team: members, devices, sign-ins, invitations (accountant preset), own roles,
  the approval rule.
- `approval-detail.tsx`: the inbox card for a change waiting for approval.
- `names.ts`: team members' names for the audit trail.

Demo mode (`?demo=1`) has `window.__gstSync.setRole(role, approvals)` and `raiseApproval()` for the e2e tests.
See `docs/decisions/0025-roles-and-permissions.md`.
