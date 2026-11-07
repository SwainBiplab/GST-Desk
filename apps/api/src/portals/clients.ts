/**
 * What an accountant sees of a client (prompt 47): the list of businesses shared with them (and the ones they
 * are a member of), each with its filing cells, what is waiting and when the books last reached the cloud; one
 * client's documents inside the shared dates; and comments, which land in the owner's inbox. Everything is read
 * under the client's organisation with row-level security; the only write is the comment.
 */
import { DocumentFlowRepo, ReviewRepo, type Ctx, type Row } from '@gst/db';
import { can } from '@gst/domain';

import { orgsOf } from '../auth/mirror';
import { inOrg, membershipOf } from '../auth/permissions';
import type { PgDatabase } from '../db/pool';
import { boardRow, type BoardRow } from '../filing/board';

import { sharesOf, type ShareAccess } from './access';

export interface ClientRow extends BoardRow {
  /** How the account reaches this client: a share, or its own membership. */
  via: 'share' | 'member';
  share: ShareAccess | null;
  stateCode: string;
  /** Inbox items waiting in the client's book. */
  waiting: number;
  /** When a device last uploaded changes, or null when nothing has synced. */
  lastSyncAt: number | null;
  /** Issued documents in the shared dates (all time for a member). */
  documents: number;
}

export interface ClientDocument {
  id: string;
  type: string;
  number: string | null;
  date: string;
  partyName: string | null;
  status: string;
  totalPaise: number;
  irn: boolean;
}

export interface CommentView {
  id: string;
  documentId: string | null;
  number: string | null;
  text: string;
  by: string;
  byName: string;
  status: string;
  createdAt: number;
}

export class ClientError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'forbidden' | 'validation',
  ) {
    super(message);
  }
}

interface Target {
  orgId: string;
  orgName: string;
  businessId: string;
  via: 'share' | 'member';
  share: ShareAccess | null;
  gst: boolean;
}

async function targetsOf(db: PgDatabase, userId: string, now: number): Promise<Target[]> {
  const out: Target[] = [];
  for (const s of await sharesOf(db, userId, now)) {
    const { orgId, orgName, ...share } = s;
    out.push({
      orgId,
      orgName,
      businessId: share.businessId,
      via: 'share',
      share,
      gst: share.perms.gst,
    });
  }
  for (const o of await orgsOf(db, userId)) {
    const m = await membershipOf(db, userId, o.id);
    if (!m) continue;
    const businesses = await inOrg(
      db,
      o.id,
      (tx) => tx`SELECT id FROM businesses WHERE deleted_at IS NULL ORDER BY legal_name`,
    );
    for (const b of businesses)
      out.push({
        orgId: o.id,
        orgName: o.name,
        businessId: String(b['id']),
        via: 'member',
        share: null,
        gst: can(m.perms, 'gst', 'view'),
      });
  }
  return out;
}

export async function clientsOf(db: PgDatabase, userId: string, now: number): Promise<ClientRow[]> {
  const rows: ClientRow[] = [];
  for (const t of await targetsOf(db, userId, now)) {
    const [b] = await inOrg(
      db,
      t.orgId,
      (tx) =>
        tx`SELECT id, trade_name, legal_name, gstin, state_code FROM businesses WHERE id = ${t.businessId} AND deleted_at IS NULL`,
    );
    if (!b) continue;
    const ctx: Ctx = { orgId: t.orgId, businessId: t.businessId, actor: userId, deviceId: 'api' };
    const base = t.gst
      ? await boardRow(db, t.orgId, t.orgName, b as Row, now, ctx)
      : {
          orgId: t.orgId,
          orgName: t.orgName,
          businessId: t.businessId,
          businessName: String(b['trade_name'] || b['legal_name']),
          gstin: String(b['gstin'] ?? ''),
          cells: [],
          exceptions: [],
        };
    const from = t.share?.from ?? '0001-01-01';
    const to = t.share?.to ?? '9999-12-31';
    const [w, d, s] = await inOrg(db, t.orgId, async (tx) => {
      const [w] =
        await tx`SELECT count(*)::int AS n FROM review_items WHERE business_id = ${t.businessId} AND status = 'pending' AND deleted_at IS NULL`;
      const [d] =
        await tx`SELECT count(*)::int AS n FROM documents WHERE business_id = ${t.businessId} AND status <> 'draft' AND deleted_at IS NULL AND date >= ${from} AND date <= ${to}`;
      const [s] =
        await tx`SELECT max(last_seen_at) AS at FROM sync_devices WHERE revoked_at IS NULL`;
      return [w, d, s] as const;
    });
    rows.push({
      ...base,
      via: t.via,
      share: t.share,
      stateCode: String(b['state_code'] ?? ''),
      waiting: Number(w?.['n'] ?? 0),
      lastSyncAt: s?.['at'] == null ? null : Number(s['at']),
      documents: Number(d?.['n'] ?? 0),
    });
  }
  return rows;
}

/** The span a caller may read: the share's, or everything for a member. */
export const spanOf = (share: ShareAccess | null | undefined) => ({
  from: share?.from ?? '0001-01-01',
  to: share?.to ?? '9999-12-31',
});

export async function clientDocuments(
  db: PgDatabase,
  ctx: Ctx,
  share: ShareAccess | null,
  f: {
    from?: string | undefined;
    to?: string | undefined;
    type?: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<{ rows: ClientDocument[]; count: number }> {
  const span = spanOf(share);
  const from = f.from && f.from > span.from ? f.from : span.from;
  const to = f.to && f.to < span.to ? f.to : span.to;
  const [rows, count] = await inOrg(db, ctx.orgId, async (tx) => {
    const where = tx`business_id = ${ctx.businessId} AND status <> 'draft' AND deleted_at IS NULL AND date >= ${from} AND date <= ${to}
      ${f.type ? tx`AND type = ${f.type}` : tx``}`;
    const rows =
      await tx`SELECT id, type, number, date, party_name, status, total_paise, irn FROM documents WHERE ${where}
      ORDER BY date DESC, number DESC LIMIT ${f.limit} OFFSET ${f.offset}`;
    const [c] = await tx`SELECT count(*)::int AS n FROM documents WHERE ${where}`;
    return [rows, Number(c?.['n'] ?? 0)] as const;
  });
  return {
    rows: rows.map((r) => ({
      id: String(r['id']),
      type: String(r['type']),
      number: (r['number'] as string | null) ?? null,
      date: String(r['date']),
      partyName: (r['party_name'] as string | null) ?? null,
      status: String(r['status']),
      totalPaise: Number(r['total_paise'] ?? 0),
      irn: !!r['irn'],
    })),
    count,
  };
}

/** One document with its lines, only inside the shared dates. */
export async function clientDocument(
  db: PgDatabase,
  ctx: Ctx,
  share: ShareAccess | null,
  id: string,
): Promise<{ document: Row; lines: Row[] } | null> {
  const found = await new DocumentFlowRepo(db).load(ctx, id);
  if (!found || found.document['deleted_at'] != null || found.document['status'] === 'draft')
    return null;
  const span = spanOf(share);
  const date = String(found.document['date']);
  if (date < span.from || date > span.to) return null;
  return { document: found.document, lines: found.lines };
}

export async function addComment(
  db: PgDatabase,
  ctx: Ctx,
  share: ShareAccess | null,
  a: { documentId: string | null; text: string; byName: string },
): Promise<CommentView> {
  const text = a.text.trim().slice(0, 2000);
  if (!text) throw new ClientError('Write the comment first.', 'validation');
  let number: string | null = null;
  if (a.documentId) {
    const d = await clientDocument(db, ctx, share, a.documentId);
    if (!d) throw new ClientError('That document was not found.', 'not_found');
    number = (d.document['number'] as string | null) ?? null;
  }
  const now = Date.now();
  const row = await new ReviewRepo(db).create(ctx, {
    kind: 'ca_comment',
    status: 'pending',
    payload_json: { shareId: share?.id ?? null },
    suggestion_json: {
      documentId: a.documentId,
      number,
      text,
      by: ctx.actor,
      byName: a.byName,
      at: now,
    },
    diff_json: null,
    source: share ? 'share' : 'member',
    confidence: null,
    dedupe_key: `ca_comment:${ctx.actor}:${now}`,
  });
  return commentView(row);
}

const commentView = (r: Row): CommentView => {
  const s = (r['suggestion_json'] ?? {}) as Record<string, unknown>;
  return {
    id: String(r['id']),
    documentId: (s['documentId'] as string | null) ?? null,
    number: (s['number'] as string | null) ?? null,
    text: String(s['text'] ?? ''),
    by: String(s['by'] ?? ''),
    byName: String(s['byName'] ?? ''),
    status: String(r['status']),
    createdAt: Number(r['created_at']),
  };
};

/** Comments on this client, newest first (a share sees everyone's: the conversation is the point). */
export async function comments(db: PgDatabase, ctx: Ctx): Promise<CommentView[]> {
  const rows = await inOrg(
    db,
    ctx.orgId,
    (tx) =>
      tx`SELECT * FROM review_items WHERE business_id = ${ctx.businessId} AND kind = 'ca_comment' AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 200`,
  );
  return rows.map(commentView);
}
