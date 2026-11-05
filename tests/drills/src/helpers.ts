/** Shared by the drills: a small book in a file, issuing documents, and the checks that say a book is sound. */
import {
  BusinessRepo,
  DocumentFlowRepo,
  ItemRepo,
  PartyRepo,
  createOrganisation,
  migrate,
  queryRows,
  type Ctx,
  type Database,
} from '@gst/db';
import { openNodeSqlite } from '@gst/db/node';
import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { sql } from 'drizzle-orm';

export const open = (file: string): Promise<Database> => openNodeSqlite(file);

export interface Book {
  d: Database;
  ctx: Ctx;
  partyId: string;
  itemId: string;
}

/** Open a file, migrate it, and make sure a business, a party and an item exist (the same ones next time). */
export async function openBook(file: string): Promise<Book> {
  const d = await open(file);
  await migrate(d);
  const existing = await queryRows(d, d.db, sql`SELECT id, org_id FROM businesses LIMIT 1`);
  if (existing[0]) {
    const base: Ctx = {
      orgId: String(existing[0]['org_id']),
      businessId: String(existing[0]['id']),
      actor: 'drill',
      deviceId: 'drill',
    };
    const p = await queryRows(d, d.db, sql`SELECT id FROM parties LIMIT 1`);
    const i = await queryRows(d, d.db, sql`SELECT id FROM items LIMIT 1`);
    return { d, ctx: base, partyId: String(p[0]!['id']), itemId: String(i[0]!['id']) };
  }
  const org = await createOrganisation(d, 'Drill org');
  const base: Ctx = { orgId: org['id'], businessId: '', actor: 'drill', deviceId: 'drill' };
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Drill Traders',
    state_code: '27',
  });
  const ctx = { ...base, businessId: biz['id'] as string };
  const party = await new PartyRepo(d).create(ctx, {
    type: 'customer',
    name: 'Sharma',
    state_code: '27',
  });
  const item = await new ItemRepo(d).create(ctx, { name: 'Bolt', hsn: '7318', gst_rate_bp: 1800 });
  return { d, ctx, partyId: party['id'], itemId: item['id'] };
}

let k = 0;
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(`k${++k}`),
  description: 'Bolt',
  qtyMicros: 2_000_000n,
  ratePaise: 50_000n,
  gstRateBp: 1800,
  ...over,
});

/** Save a draft invoice and issue it, as the editor does. */
export async function issueOne(b: Book): Promise<string> {
  const flow = new DocumentFlowRepo(b.d);
  const draft: DraftDocument = {
    ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
    partyId: b.partyId,
    lines: [line({ itemId: b.itemId })],
  };
  const r = draftToRows(draft);
  const saved = await flow.saveDraft(b.ctx, {
    doc: r.doc as unknown as Record<string, unknown>,
    lines: r.lines as unknown as Record<string, unknown>[],
  });
  const issued = await flow.issueDraft(b.ctx, saved.document['id'], saved.document['version'], {
    inventoryEnabled: false,
  });
  return String((issued as { document?: { number?: string } }).document?.number ?? '');
}

const one = async (d: Database, text: ReturnType<typeof sql>) =>
  (await queryRows(d, d.db, text))[0] ?? {};

export interface Soundness {
  integrity: string;
  foreignKeyViolations: number;
  issuedWithoutNumber: number;
  duplicateNumbers: number;
  draftsWithNumber: number;
  issuedWithoutLedger: number;
  /** For each series: numbers handed out minus documents issued from it (0 when nothing is lost or reused). */
  seriesDrift: number[];
  issued: number;
}

/** What must be true of a book at any moment, even one that was cut off in the middle of a write. */
export async function soundness(d: Database): Promise<Soundness> {
  const integrity = String((await one(d, sql`PRAGMA integrity_check`))['integrity_check'] ?? '');
  const fk = await queryRows(d, d.db, sql`PRAGMA foreign_key_check`);
  const n = async (text: ReturnType<typeof sql>) => Number((await one(d, text))['c'] ?? 0);
  const series = await queryRows(
    d,
    d.db,
    sql`SELECT s.next_number AS next, s.document_type AS type,
               (SELECT count(*) FROM documents x WHERE x.status = 'issued' AND x.number IS NOT NULL
                  AND x.type = s.document_type AND x.deleted_at IS NULL) AS issued
        FROM number_series s`,
  );
  return {
    integrity,
    foreignKeyViolations: fk.length,
    issuedWithoutNumber: await n(
      sql`SELECT count(*) AS c FROM documents WHERE status = 'issued' AND (number IS NULL OR number = '')`,
    ),
    duplicateNumbers: await n(
      sql`SELECT count(*) AS c FROM (SELECT number FROM documents WHERE number IS NOT NULL GROUP BY type, number HAVING count(*) > 1)`,
    ),
    draftsWithNumber: await n(
      sql`SELECT count(*) AS c FROM documents WHERE status = 'draft' AND number IS NOT NULL AND number <> ''`,
    ),
    issuedWithoutLedger: await n(
      sql`SELECT count(*) AS c FROM documents d WHERE d.status = 'issued' AND d.type = 'tax_invoice'
            AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.document_id = d.id)`,
    ),
    seriesDrift: series.map((s) => Number(s['next']) - 1 - Number(s['issued'])),
    issued: await n(sql`SELECT count(*) AS c FROM documents WHERE status = 'issued'`),
  };
}

export const SOUND: Omit<Soundness, 'issued'> = {
  integrity: 'ok',
  foreignKeyViolations: 0,
  issuedWithoutNumber: 0,
  duplicateNumbers: 0,
  draftsWithNumber: 0,
  issuedWithoutLedger: 0,
  seriesDrift: [0],
};
