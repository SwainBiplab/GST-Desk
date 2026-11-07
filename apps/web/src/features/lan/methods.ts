/**
 * What a paired device can ask the desktop to do. Every method is one call on a repository, so the same
 * rules the desktop's own screens obey (tax engine, totals check, numbering, locks, audit) apply to a
 * tablet, and one call is one transaction: a tablet never holds a transaction open across the network.
 *
 * `access` decides who may call it: `read` (every device), `sell` (counter and full: billing at a shop),
 * `admin` (full only). Writes to an existing document lock it to one device at a time.
 */
import {
  BusinessRepo,
  DocumentFlowRepo,
  ItemRepo,
  PartyRepo,
  PaymentFlowRepo,
  type Ctx,
  type Database,
  type Row,
} from '@gst/db';
import type { MethodDef } from '@gst/lan';

export interface MethodOptions {
  /** Whether issuing takes stock out, as the desktop's own setting says. */
  inventoryEnabled: () => boolean;
}

const MAX_ROWS = 500;
const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const limit = (v: unknown): number =>
  Math.min(MAX_ROWS, Math.max(1, Number.isFinite(Number(v)) ? Number(v) : 50));
const pick = (src: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
const need = (v: unknown, what: string): string => {
  const s = text(v, 80);
  if (!s) throw new Error(`${what} is needed.`);
  return s;
};

/** Rows leave the desktop without the columns a tablet has no use for. */
const slim = (r: Row): Record<string, unknown> => {
  const {
    org_id: _o,
    created_by: _c,
    updated_by: _u,
    deleted_at: _d,
    ...rest
  } = r as Record<string, unknown>;
  void _o;
  void _c;
  void _u;
  void _d;
  return rest;
};

export function lanMethods(d: Database, ctx: Ctx, o: MethodOptions): Map<string, MethodDef> {
  const flow = new DocumentFlowRepo(d);
  const parties = new PartyRepo(d);
  const items = new ItemRepo(d);
  const m = new Map<string, MethodDef>();
  const add = (name: string, def: MethodDef) => m.set(name, def);
  const docLock = (p: { id?: unknown }) =>
    typeof p?.id === 'string' && p.id ? `doc:${p.id}` : null;

  add('business.get', {
    access: 'read',
    run: async () => slim((await new BusinessRepo(d).get(ctx)) as Row),
  });
  add('parties.list', {
    access: 'read',
    run: async (p: { limit?: unknown }) =>
      (await parties.list(ctx, { orderBy: d.schema.parties.name, limit: limit(p?.limit) })).map(
        slim,
      ),
  });
  add('parties.search', {
    access: 'read',
    run: async (p: { q?: unknown; limit?: unknown }) =>
      (await parties.search(ctx, text(p?.q, 80), limit(p?.limit))).map(slim),
  });
  add('items.list', {
    access: 'read',
    run: async (p: { limit?: unknown }) =>
      (await items.list(ctx, { orderBy: d.schema.items.name, limit: limit(p?.limit) })).map(slim),
  });
  add('items.search', {
    access: 'read',
    run: async (p: { q?: unknown; limit?: unknown }) =>
      (await items.search(ctx, text(p?.q, 80), limit(p?.limit))).map(slim),
  });
  add('documents.load', {
    access: 'read',
    run: async (p: { id?: unknown }) => {
      const doc = await flow.load(ctx, need(p?.id, 'The document'));
      return doc ? { document: slim(doc.document), lines: doc.lines.map(slim) } : null;
    },
  });
  add('parties.create', {
    access: 'sell',
    run: async (p: Record<string, unknown>) =>
      slim(
        await parties.create(ctx, {
          type: 'customer',
          country: 'India',
          ...pick(p, [
            'type',
            'name',
            'gstin',
            'pan',
            'state_code',
            'phone',
            'city',
            'is_unregistered',
          ]),
          name: need(p?.['name'], 'A name'),
        } as never),
      ),
  });
  add('documents.saveDraft', {
    access: 'sell',
    lock: docLock,
    run: async (p: {
      id?: unknown;
      doc?: Record<string, unknown>;
      lines?: Record<string, unknown>[];
    }) => {
      if (!p?.doc || !Array.isArray(p.lines)) throw new Error('Send the document and its lines.');
      const saved = await flow.saveDraft(ctx, {
        ...(typeof p.id === 'string' ? { id: p.id } : {}),
        doc: p.doc,
        lines: p.lines,
      } as never);
      return { document: slim(saved.document) };
    },
  });
  add('documents.issue', {
    access: 'sell',
    lock: docLock,
    releaseAfter: true,
    run: async (p: { id?: unknown; version?: unknown }) => {
      const r = await flow.issueDraft(ctx, need(p?.id, 'The document'), Number(p?.version), {
        shell: 'shop',
        inventoryEnabled: o.inventoryEnabled(),
      });
      return { document: slim(r.document) };
    },
  });
  add('payments.record', {
    access: 'sell',
    run: async (p: { input?: Record<string, unknown> }) => {
      if (!p?.input) throw new Error('Send the payment.');
      const r = await new PaymentFlowRepo(d).record(ctx, p.input as never);
      return {
        payment: slim(r.payment),
        voucher: r.voucher ? slim(r.voucher) : null,
        remainderPaise: r.remainderPaise,
      };
    },
  });
  add('documents.cancel', {
    access: 'admin',
    lock: docLock,
    releaseAfter: true,
    run: async (p: { id?: unknown; version?: unknown; reason?: unknown }) => {
      const r = await flow.cancelDocument(
        ctx,
        need(p?.id, 'The document'),
        Number(p?.version),
        text(p?.reason, 300),
      );
      return { document: slim(r.document) };
    },
  });
  return m;
}
