/**
 * Sharing a business with an accountant (prompt 47): the owner invites an address (or a phone number, which is
 * addressed to the e-mail a phone sign-in gets), chooses the financial year or dates and what the accountant may
 * do (read the books, see the GST module, take exports, leave comments) and can revoke at any time; the
 * accountant accepts after signing in with that address. An accepted share is what `shareAccessOf` turns into
 * access; a revoked one stops holding from the next request.
 */
import { newId } from '@gst/db';
import { financialYear } from '@gst/domain';

import { inOrg } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';

import { sharePermsOf, type SharePerms } from './access';

export const SHARE_INVITE_DAYS = 14;

export interface ShareView {
  id: string;
  businessId: string;
  email: string;
  status: 'pending' | 'active' | 'revoked' | 'declined';
  from: string;
  to: string;
  perms: SharePerms;
  expiresAt: number | null;
  note: string | null;
  createdAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
}

export interface ShareInvite {
  id: string;
  orgName: string;
  businessName: string;
  gstin: string | null;
  from: string;
  to: string;
  perms: SharePerms;
  note: string | null;
  createdAt: number;
}

export class ShareError extends Error {
  constructor(
    message: string,
    readonly code: 'validation' | 'conflict' | 'not_found' | 'expired',
  ) {
    super(message);
  }
}

/** `2026-27` is 1 April 2026 to 31 March 2027 (the business's own start month applies). */
export function fyRange(fy: string, startMonth = 4): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) throw new ShareError('Give the financial year as 2026-27.', 'validation');
  const y = Number(m[1]);
  if (Number(m[2]) !== (y + 1) % 100)
    throw new ShareError('Give the financial year as 2026-27.', 'validation');
  const f = financialYear(y, startMonth);
  return { from: f.start, to: f.end };
}

const view = (r: Record<string, unknown>): ShareView => ({
  id: String(r['id']),
  businessId: String(r['business_id']),
  email: String(r['grantee_email']),
  status: String(r['status']) as ShareView['status'],
  from: String(r['scope_from']),
  to: String(r['scope_to']),
  perms: sharePermsOf(r['perms']),
  expiresAt: r['expires_at'] == null ? null : Number(r['expires_at']),
  note: (r['note'] as string | null) ?? null,
  createdAt: Number(r['created_at']),
  acceptedAt: r['accepted_at'] == null ? null : Number(r['accepted_at']),
  revokedAt: r['revoked_at'] == null ? null : Number(r['revoked_at']),
});

export class ShareService {
  constructor(
    private readonly db: PgDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async list(orgId: string, businessId: string): Promise<ShareView[]> {
    const rows = await inOrg(
      this.db,
      orgId,
      (tx) =>
        tx`SELECT * FROM business_shares WHERE org_id = ${orgId} AND business_id = ${businessId}
           ORDER BY (status IN ('pending', 'active')) DESC, created_at DESC`,
    );
    return rows.map(view);
  }

  async create(a: {
    orgId: string;
    businessId: string;
    email: string;
    from: string;
    to: string;
    perms: SharePerms;
    expiresAt: number | null;
    note: string | null;
    by: string;
  }): Promise<ShareView> {
    if (a.from > a.to) throw new ShareError('The dates are the wrong way round.', 'validation');
    const now = this.now();
    if (a.expiresAt !== null && a.expiresAt <= now)
      throw new ShareError('The access would already have ended.', 'validation');
    const email = a.email.trim().toLowerCase();
    // the owner's own address, or a member's, needs no share
    const [member] = await this.db
      .sql`SELECT 1 FROM auth_member m JOIN auth_user u ON u.id = m.user_id
      WHERE m.organization_id = ${a.orgId} AND lower(u.email) = ${email}`;
    if (member) throw new ShareError('They are already in the team.', 'conflict');
    const id = newId();
    const row = await inOrg(this.db, a.orgId, async (tx) => {
      // a new share replaces the live one for the same address and business
      await tx`UPDATE business_shares SET status = 'revoked', revoked_at = ${now}, revoked_by = ${a.by}, updated_at = ${now}
        WHERE org_id = ${a.orgId} AND business_id = ${a.businessId} AND lower(grantee_email) = ${email} AND status IN ('pending', 'active')`;
      const [r] =
        await tx`INSERT INTO business_shares (id, org_id, business_id, grantee_email, scope_from, scope_to, perms, status,
          expires_at, note, created_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${email}, ${a.from}, ${a.to}, ${JSON.stringify(a.perms)}::jsonb, 'pending',
          ${a.expiresAt}, ${a.note}, ${a.by}, ${now}, ${now}) RETURNING *`;
      return r!;
    });
    return view(row);
  }

  async revoke(orgId: string, id: string, by: string): Promise<ShareView> {
    const now = this.now();
    const [r] = await inOrg(
      this.db,
      orgId,
      (tx) =>
        tx`UPDATE business_shares SET status = 'revoked', revoked_at = ${now}, revoked_by = ${by}, updated_at = ${now}
           WHERE org_id = ${orgId} AND id = ${id} AND status IN ('pending', 'active') RETURNING *`,
    );
    if (!r) throw new ShareError('That share was not found.', 'not_found');
    return view(r);
  }

  /** Shares waiting for this address. */
  async invitesFor(email: string): Promise<ShareInvite[]> {
    const now = this.now();
    const rows = await this.db.sql`SELECT g.*, o.name AS org_name FROM business_share_grants g
      JOIN organisations o ON o.id = g.org_id
      WHERE g.status = 'pending' AND g.grantee_email = ${email.toLowerCase()}
        AND g.created_at > ${now - SHARE_INVITE_DAYS * 86_400_000}
      ORDER BY g.created_at DESC`;
    const out: ShareInvite[] = [];
    for (const r of rows) {
      const [b] = await inOrg(
        this.db,
        String(r['org_id']),
        (tx) =>
          tx`SELECT trade_name, legal_name, gstin FROM businesses WHERE id = ${String(r['business_id'])}`,
      );
      out.push({
        id: String(r['id']),
        orgName: String(r['org_name']),
        businessName: String(b?.['trade_name'] || b?.['legal_name'] || ''),
        gstin: (b?.['gstin'] as string | null) ?? null,
        from: String(r['scope_from']),
        to: String(r['scope_to']),
        perms: sharePermsOf(r['perms']),
        note: (r['note'] as string | null) ?? null,
        createdAt: Number(r['created_at']),
      });
    }
    return out;
  }

  /** Accept or decline; only the invited address can, and someone else's invitation is "not found". */
  async answer(
    id: string,
    user: { id: string; email: string },
    accept: boolean,
  ): Promise<{ orgId: string; businessId: string }> {
    const now = this.now();
    const [g] = await this.db
      .sql`SELECT org_id, business_id, created_at FROM business_share_grants WHERE id = ${id} AND status = 'pending' AND grantee_email = ${user.email.toLowerCase()}`;
    if (!g) throw new ShareError('That invitation was not found.', 'not_found');
    const orgId = String(g['org_id']);
    if (Number(g['created_at']) <= now - SHARE_INVITE_DAYS * 86_400_000) {
      await inOrg(
        this.db,
        orgId,
        (tx) =>
          tx`UPDATE business_shares SET status = 'declined', updated_at = ${now} WHERE id = ${id}`,
      );
      throw new ShareError('That invitation has expired. Ask for a new one.', 'expired');
    }
    await inOrg(this.db, orgId, (tx) =>
      accept
        ? tx`UPDATE business_shares SET status = 'active', grantee_user_id = ${user.id}, accepted_at = ${now}, updated_at = ${now} WHERE id = ${id}`
        : tx`UPDATE business_shares SET status = 'declined', updated_at = ${now} WHERE id = ${id}`,
    );
    return { orgId, businessId: String(g['business_id']) };
  }
}
