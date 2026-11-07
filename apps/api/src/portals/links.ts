/**
 * The customer's portal (prompt 47): a public link to one invoice or one party statement. The token is 128 bits
 * from the system's random source; only its SHA-256 is stored and matched (constant-time by the index, with the
 * organisation the only thing the lookup yields), and the token itself is kept sealed under the platform key when
 * there is one so the owner can copy the link again. A page shows exactly one document or statement, never an
 * id of ours; a link expires, can be revoked, and goes dark when the business turns its portal off.
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  BusinessRepo,
  DocumentFlowRepo,
  PartyRepo,
  PaymentFlowRepo,
  ReviewRepo,
  getPartyStatement,
  newId,
  type Ctx,
  type Row,
} from '@gst/db';
import { today as istToday } from '@gst/domain';
import { openSecret, sealSecret } from '@gst/payments';
import { printBusiness } from '@gst/print';

import { inOrg } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';
import { renderDocumentPdf } from '../messaging/pdf';
import type { PaymentsService } from '../payments/service';

export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const DEFAULT_LINK_DAYS = 90;
export const QUESTIONS_PER_DAY = 20;
const DAY = 86_400_000;

export interface PortalSettings {
  enabled: boolean;
  linkDays: number;
  statements: boolean;
  questions: boolean;
}

export interface LinkView {
  id: string;
  kind: 'document' | 'statement';
  documentId: string | null;
  partyId: string | null;
  /** The full address, when the token could be opened again (sealed under the platform key). */
  url: string | null;
  expiresAt: number;
  status: 'live' | 'expired' | 'revoked';
  views: number;
  lastViewedAt: number | null;
  createdAt: number;
}

export interface PortalLine {
  description: string;
  hsn: string | null;
  qty: string;
  unit: string | null;
  ratePaise: number;
  taxablePaise: number;
  gstRateBp: number;
  totalPaise: number;
}

export interface PortalDocument {
  kind: 'document';
  business: PortalBusiness;
  document: {
    type: string;
    number: string | null;
    date: string;
    dueDate: string | null;
    partyName: string | null;
    placeOfSupply: string | null;
    status: 'issued' | 'cancelled';
    lines: PortalLine[];
    taxablePaise: number;
    taxPaise: number;
    roundOffPaise: number;
    totalPaise: number;
    paidPaise: number;
    balancePaise: number;
    payStatus: 'paid' | 'part' | 'unpaid' | 'not_payable';
    notes: string | null;
    terms: string | null;
  };
  pay: { available: boolean; url: string | null };
  questions: boolean;
  expiresAt: number;
}

export interface PortalStatement {
  kind: 'statement';
  business: PortalBusiness;
  party: { name: string; gstin: string | null };
  range: { from: string | null; to: string | null };
  openingPaise: number;
  closingPaise: number;
  lines: {
    date: string;
    kind: string;
    ref: string;
    description: string;
    debitPaise: number;
    creditPaise: number;
    balancePaise: number;
  }[];
  questions: boolean;
  expiresAt: number;
}

export interface PortalBusiness {
  name: string;
  gstin: string | null;
  address: string[];
  phone: string | null;
  email: string | null;
}

export class PortalError extends Error {
  constructor(
    message: string,
    readonly code:
      'not_found' | 'gone' | 'disabled' | 'no_payments' | 'nothing_owed' | 'rule' | 'limit',
  ) {
    super(message);
  }
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(16).toString('base64url');

interface Resolved {
  orgId: string;
  link: Row;
  settings: PortalSettings;
}

const settingsOf = (r: Row | undefined): PortalSettings => ({
  enabled: r?.['enabled'] === true,
  linkDays: Number(r?.['link_days'] ?? DEFAULT_LINK_DAYS),
  statements: r?.['statements'] !== false,
  questions: r?.['questions'] !== false,
});

export class PortalService {
  constructor(
    private readonly o: {
      db: PgDatabase;
      /** Where the pages live: the link is `${portalUrl}/p/${token}`. */
      portalUrl: string;
      secretsKey: string | null;
      payments?: PaymentsService | undefined;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  private ctx(orgId: string, businessId: string, actor = 'portal'): Ctx {
    return { orgId, businessId, actor, deviceId: 'api' };
  }

  url(token: string): string {
    return `${this.o.portalUrl}/p/${token}`;
  }

  /* ------------------------------------------------------------------------------ owner side */

  async settings(orgId: string, businessId: string): Promise<PortalSettings> {
    const [r] = await inOrg(
      this.o.db,
      orgId,
      (tx) =>
        tx`SELECT * FROM portal_settings WHERE org_id = ${orgId} AND business_id = ${businessId}`,
    );
    return settingsOf(r);
  }

  async saveSettings(
    orgId: string,
    businessId: string,
    patch: Partial<PortalSettings>,
    by: string,
  ): Promise<PortalSettings> {
    const cur = await this.settings(orgId, businessId);
    const next = { ...cur, ...patch };
    const now = this.now();
    await inOrg(
      this.o.db,
      orgId,
      (tx) =>
        tx`INSERT INTO portal_settings (org_id, business_id, enabled, link_days, statements, questions, updated_by, updated_at)
        VALUES (${orgId}, ${businessId}, ${next.enabled}, ${next.linkDays}, ${next.statements}, ${next.questions}, ${by}, ${now})
        ON CONFLICT (org_id, business_id) DO UPDATE SET enabled = EXCLUDED.enabled, link_days = EXCLUDED.link_days,
          statements = EXCLUDED.statements, questions = EXCLUDED.questions, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    );
    return next;
  }

  private view(orgId: string, r: Row): LinkView {
    const now = this.now();
    let url: string | null = null;
    if (r['token_enc'] && this.o.secretsKey) {
      try {
        url = this.url(openSecret(String(r['token_enc']), this.o.secretsKey, orgId));
      } catch {
        url = null;
      }
    }
    return {
      id: String(r['id']),
      kind: String(r['kind']) as LinkView['kind'],
      documentId: (r['document_id'] as string | null) ?? null,
      partyId: (r['party_id'] as string | null) ?? null,
      url,
      expiresAt: Number(r['expires_at']),
      status:
        r['revoked_at'] != null ? 'revoked' : Number(r['expires_at']) <= now ? 'expired' : 'live',
      views: Number(r['views'] ?? 0),
      lastViewedAt: r['last_viewed_at'] == null ? null : Number(r['last_viewed_at']),
      createdAt: Number(r['created_at']),
    };
  }

  /** Make a link; the token is in the answer once, and in `url` again later only under the platform key. */
  async createLink(a: {
    orgId: string;
    businessId: string;
    documentId?: string | undefined;
    partyId?: string | undefined;
    days?: number | undefined;
    by: string;
  }): Promise<LinkView & { url: string }> {
    const kind = a.documentId ? 'document' : 'statement';
    const ctx = this.ctx(a.orgId, a.businessId, a.by);
    if (kind === 'document') {
      const found = await new DocumentFlowRepo(this.o.db).load(ctx, a.documentId!);
      if (!found || found.document['deleted_at'] != null)
        throw new PortalError('That document was not found.', 'not_found');
      if (found.document['status'] === 'draft')
        throw new PortalError('A draft has no customer link; issue it first.', 'rule');
    } else {
      const settings = await this.settings(a.orgId, a.businessId);
      if (!settings.statements)
        throw new PortalError('Statement links are turned off for this business.', 'disabled');
      const p = await new PartyRepo(this.o.db).get(ctx, a.partyId!);
      if (!p || p['deleted_at'] != null)
        throw new PortalError('That party was not found.', 'not_found');
    }
    const settings = await this.settings(a.orgId, a.businessId);
    const now = this.now();
    const days = a.days ?? settings.linkDays;
    const token = newToken();
    const id = newId();
    const enc = this.o.secretsKey ? sealSecret(token, this.o.secretsKey, a.orgId) : null;
    const [row] = await inOrg(
      this.o.db,
      a.orgId,
      (tx) =>
        tx`INSERT INTO portal_links (id, org_id, business_id, kind, document_id, party_id, token_hash, token_enc, expires_at,
          created_by, created_at, updated_at)
        VALUES (${id}, ${a.orgId}, ${a.businessId}, ${kind}, ${a.documentId ?? null}, ${a.partyId ?? null}, ${hashToken(token)}, ${enc},
          ${now + days * DAY}, ${a.by}, ${now}, ${now}) RETURNING *`,
    );
    return { ...this.view(a.orgId, row!), url: this.url(token) };
  }

  async links(
    orgId: string,
    businessId: string,
    f: { documentId?: string | undefined; partyId?: string | undefined },
  ): Promise<LinkView[]> {
    const rows = await inOrg(this.o.db, orgId, (tx) =>
      f.documentId
        ? tx`SELECT * FROM portal_links WHERE org_id = ${orgId} AND business_id = ${businessId} AND document_id = ${f.documentId} ORDER BY created_at DESC`
        : f.partyId
          ? tx`SELECT * FROM portal_links WHERE org_id = ${orgId} AND business_id = ${businessId} AND party_id = ${f.partyId} ORDER BY created_at DESC`
          : tx`SELECT * FROM portal_links WHERE org_id = ${orgId} AND business_id = ${businessId} ORDER BY created_at DESC LIMIT 200`,
    );
    return rows.map((r) => this.view(orgId, r));
  }

  async revoke(orgId: string, id: string, by: string): Promise<LinkView> {
    const now = this.now();
    const [r] = await inOrg(
      this.o.db,
      orgId,
      (tx) =>
        tx`UPDATE portal_links SET revoked_at = ${now}, revoked_by = ${by}, updated_at = ${now}
           WHERE org_id = ${orgId} AND id = ${id} AND revoked_at IS NULL RETURNING *`,
    );
    if (!r) throw new PortalError('That link was not found.', 'not_found');
    return this.view(orgId, r);
  }

  /* ----------------------------------------------------------------------------- public side */

  /** A token to its link, or an error that says only "not found" or "gone". */
  private async resolve(token: string): Promise<Resolved> {
    if (!TOKEN_RE.test(token)) throw new PortalError('That link was not found.', 'not_found');
    const [hit] = await this.o.db
      .sql`SELECT org_id FROM portal_link_lookup WHERE token_hash = ${hashToken(token)}`;
    if (!hit) throw new PortalError('That link was not found.', 'not_found');
    const orgId = String(hit['org_id']);
    const [link, settings] = await inOrg(this.o.db, orgId, async (tx) => {
      const [l] = await tx`SELECT * FROM portal_links WHERE token_hash = ${hashToken(token)}`;
      const [s] = l
        ? await tx`SELECT * FROM portal_settings WHERE org_id = ${orgId} AND business_id = ${String(l['business_id'])}`
        : [undefined];
      return [l, s] as const;
    });
    if (!link) throw new PortalError('That link was not found.', 'not_found');
    const gone =
      link['revoked_at'] != null ||
      Number(link['expires_at']) <= this.now() ||
      (link['kind'] === 'statement' && settings?.['statements'] === false);
    if (gone) throw new PortalError('This link is no longer available.', 'gone');
    if (settings?.['enabled'] !== true)
      throw new PortalError('This business has not turned its customer pages on.', 'disabled');
    return { orgId, link, settings: settingsOf(settings) };
  }

  private async business(ctx: Ctx): Promise<PortalBusiness> {
    const b = await new BusinessRepo(this.o.db).get(ctx);
    if (!b) throw new PortalError('This link is no longer available.', 'gone');
    const p = printBusiness(b, null);
    return { name: p.name, gstin: p.gstin, address: p.address, phone: p.phone, email: p.email };
  }

  private async seen(orgId: string, id: string): Promise<void> {
    const now = this.now();
    await inOrg(
      this.o.db,
      orgId,
      (tx) =>
        tx`UPDATE portal_links SET views = views + 1, last_viewed_at = ${now} WHERE id = ${id}`,
    ).catch(() => undefined);
  }

  async page(token: string): Promise<PortalDocument | PortalStatement> {
    const r = await this.resolve(token);
    const businessId = String(r.link['business_id']);
    const ctx = this.ctx(r.orgId, businessId);
    const business = await this.business(ctx);
    const expiresAt = Number(r.link['expires_at']);
    void this.seen(r.orgId, String(r.link['id']));
    if (r.link['kind'] === 'statement') {
      const partyId = String(r.link['party_id']);
      const party = await new PartyRepo(this.o.db).get(ctx, partyId);
      if (!party) throw new PortalError('This link is no longer available.', 'gone');
      const st = await getPartyStatement(this.o.db, ctx, partyId);
      return {
        kind: 'statement',
        business,
        party: { name: String(party['name']), gstin: (party['gstin'] as string | null) ?? null },
        range: { from: null, to: null },
        openingPaise: Number(st.openingBalancePaise),
        closingPaise: Number(st.closingBalancePaise),
        lines: st.lines.map((l) => ({
          date: l.date,
          kind: l.kind,
          ref: l.ref,
          description: l.description,
          debitPaise: Number(l.debitPaise),
          creditPaise: Number(l.creditPaise),
          balancePaise: Number(l.balancePaise),
        })),
        questions: r.settings.questions,
        expiresAt,
      };
    }
    const documentId = String(r.link['document_id']);
    const found = await new DocumentFlowRepo(this.o.db).load(ctx, documentId);
    if (!found || found.document['deleted_at'] != null || found.document['status'] === 'draft')
      throw new PortalError('This link is no longer available.', 'gone');
    const doc = found.document;
    const units = new Map(
      (
        await inOrg(
          this.o.db,
          r.orgId,
          (tx) => tx`SELECT id, code FROM units WHERE deleted_at IS NULL`,
        )
      ).map((u) => [String(u['id']), String(u['code'])]),
    );
    const pos = (
      await new PaymentFlowRepo(this.o.db).positions(
        ctx,
        istToday(() => new Date(this.now())),
      )
    ).documents.find((d) => d.id === documentId);
    const payable = ['tax_invoice', 'bill_of_supply'].includes(String(doc['type']));
    const balance = pos ? Number(pos.balancePaise) : 0;
    const paid = pos ? Number(pos.paidPaise) + Number(pos.creditAppliedPaise) : 0;
    const cancelled = doc['status'] === 'cancelled';
    const payStatus: PortalDocument['document']['payStatus'] =
      !payable || cancelled ? 'not_payable' : balance <= 0 ? 'paid' : paid > 0 ? 'part' : 'unpaid';
    const tax =
      Number(doc['total_cgst_paise'] ?? 0) +
      Number(doc['total_sgst_paise'] ?? 0) +
      Number(doc['total_igst_paise'] ?? 0) +
      Number(doc['total_utgst_paise'] ?? 0) +
      Number(doc['total_cess_paise'] ?? 0);
    // a live payment link the business already made is the one to offer; otherwise one is made on "Pay"
    const live = this.o.payments
      ? (await this.o.payments.requestsFor(r.orgId, documentId)).find(
          (q) => q.kind === 'link' && ['created', 'partial'].includes(q.status) && q.url,
        )
      : undefined;
    const gateway = this.o.payments
      ? await this.o.payments.status(r.orgId, businessId).catch(() => null)
      : null;
    return {
      kind: 'document',
      business,
      document: {
        type: String(doc['type']),
        number: (doc['number'] as string | null) ?? null,
        date: String(doc['date']),
        dueDate: (doc['due_date'] as string | null) ?? null,
        partyName: (doc['party_name'] as string | null) ?? null,
        placeOfSupply: (doc['place_of_supply_state'] as string | null) ?? null,
        status: cancelled ? 'cancelled' : 'issued',
        lines: found.lines.map((l) => ({
          description: String(l['description'] ?? ''),
          hsn: (l['hsn'] as string | null) ?? null,
          qty: (Number(l['qty_micros'] ?? 0) / 1_000_000).toString(),
          unit: l['unit_id'] ? (units.get(String(l['unit_id'])) ?? null) : null,
          ratePaise: Number(l['rate_paise'] ?? 0),
          taxablePaise: Number(l['taxable_paise'] ?? 0),
          gstRateBp: Number(l['gst_rate_bp'] ?? 0),
          totalPaise: Number(l['total_paise'] ?? 0),
        })),
        taxablePaise: Number(doc['total_taxable_paise'] ?? 0),
        taxPaise: tax,
        roundOffPaise: Number(doc['round_off_paise'] ?? 0),
        totalPaise: Number(doc['total_paise'] ?? 0),
        paidPaise: paid,
        balancePaise: Math.max(0, balance),
        payStatus,
        notes: (doc['notes'] as string | null) ?? null,
        terms: (doc['terms'] as string | null) ?? null,
      },
      pay: {
        available: payStatus === 'unpaid' || payStatus === 'part' ? !!gateway?.connected : false,
        url: live?.url ?? null,
      },
      questions: r.settings.questions,
      expiresAt,
    };
  }

  async pdf(token: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    const r = await this.resolve(token);
    if (r.link['kind'] !== 'document')
      throw new PortalError('A statement has no PDF here.', 'not_found');
    const ctx = this.ctx(r.orgId, String(r.link['business_id']));
    const out = await renderDocumentPdf(this.o.db, ctx, String(r.link['document_id']));
    if (!out) throw new PortalError('This link is no longer available.', 'gone');
    return { bytes: out.bytes, fileName: out.fileName };
  }

  /** The customer presses Pay: the live payment link, or a new one for what is still owed. */
  async pay(token: string): Promise<{ url: string; amountPaise: number; expiresAt: number }> {
    const r = await this.resolve(token);
    if (r.link['kind'] !== 'document' || !this.o.payments)
      throw new PortalError('Paying online is not available for this business.', 'no_payments');
    const orgId = r.orgId;
    const businessId = String(r.link['business_id']);
    const documentId = String(r.link['document_id']);
    const gateway = await this.o.payments.status(orgId, businessId).catch(() => null);
    if (!gateway?.connected)
      throw new PortalError('Paying online is not available for this business.', 'no_payments');
    try {
      const req = await this.o.payments.createRequest({
        orgId,
        businessId,
        documentId,
        kind: 'link',
        by: 'portal',
      });
      if (!req.url) throw new PortalError('The payment link could not be made.', 'no_payments');
      return { url: req.url, amountPaise: req.amountPaise, expiresAt: req.expiresAt };
    } catch (e) {
      if (e instanceof PortalError) throw e;
      if ((e as { code?: string }).code === 'not_payable')
        throw new PortalError('Nothing is owed on this invoice.', 'nothing_owed');
      throw new PortalError('The payment link could not be made.', 'no_payments');
    }
  }

  /** A question or dispute from the customer lands in the owner's inbox. */
  async question(
    token: string,
    q: { name: string | null; contact: string | null; text: string },
  ): Promise<void> {
    const r = await this.resolve(token);
    if (!r.settings.questions)
      throw new PortalError('Questions are turned off for this business.', 'disabled');
    const businessId = String(r.link['business_id']);
    const ctx = this.ctx(r.orgId, businessId);
    const text = q.text.trim().slice(0, 2000);
    if (!text) throw new PortalError('Write what the question is.', 'rule');
    let number: string | null = null;
    if (r.link['kind'] === 'document') {
      const [d] = await inOrg(
        this.o.db,
        r.orgId,
        (tx) => tx`SELECT number FROM documents WHERE id = ${String(r.link['document_id'])}`,
      );
      number = (d?.['number'] as string | null) ?? null;
    }
    const key = createHash('sha256').update(`${r.link['id']}:${text}`).digest('hex').slice(0, 24);
    // a link may raise so many questions a day: the rate limit bounds the minute, this bounds the inbox
    const [n] = await inOrg(
      this.o.db,
      r.orgId,
      (tx) =>
        tx`SELECT count(*)::int AS n FROM review_items WHERE business_id = ${businessId} AND kind = 'portal_question'
           AND payload_json->>'linkId' = ${String(r.link['id'])} AND created_at > ${this.now() - 86_400_000}`,
    );
    if (Number(n?.['n'] ?? 0) >= QUESTIONS_PER_DAY)
      throw new PortalError(
        'Too many questions from this link today. Call the business instead.',
        'limit',
      );
    // the same question twice (a double press, a retry) is one inbox item
    const [dup] = await inOrg(
      this.o.db,
      r.orgId,
      (tx) =>
        tx`SELECT 1 FROM review_items WHERE business_id = ${businessId} AND kind = 'portal_question' AND dedupe_key = ${`portal_question:${key}`} AND deleted_at IS NULL`,
    );
    if (dup) return;
    try {
      await new ReviewRepo(this.o.db).create(ctx, {
        kind: 'portal_question',
        status: 'pending',
        payload_json: { linkId: String(r.link['id']) },
        suggestion_json: {
          documentId: (r.link['document_id'] as string | null) ?? null,
          partyId: (r.link['party_id'] as string | null) ?? null,
          number,
          name: q.name?.trim().slice(0, 120) || null,
          contact: q.contact?.trim().slice(0, 120) || null,
          text,
          at: this.now(),
        },
        diff_json: null,
        source: 'portal',
        confidence: null,
        dedupe_key: `portal_question:${key}`,
      });
    } catch {
      /* the same question twice is one inbox item */
    }
  }
}
