import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DocumentType,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import {
  buildTallyMasters,
  buildTallyVouchers,
  readTally,
  type ImportBundle,
  type ImportDocument,
} from '@gst/interop';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { queryRows, type Database } from '../database';
import { DIALECTS, openTestDb } from '../testing/harness';

import { BusinessRepo, ItemRepo, PartyRepo, createOrganisation } from './aggregates';
import { runInTx, type Ctx } from './base';
import { DocumentFlowRepo } from './document-flow';
import { InteropRepo } from './interop';
import { PaymentFlowRepo } from './payment-flow';
import { PeriodLockRepo } from './period-lock';

const R = (n: number): bigint => BigInt(Math.round(n * 100));
let k = 0;
const line = (rate: bigint, over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(`k${++k}`),
  description: 'Cement bag',
  hsn: '2523',
  qtyMicros: 10_000_000n,
  ratePaise: rate,
  gstRateBp: 1800,
  ...over,
});

describe.each(DIALECTS)('moving data in and out (%s)', (dialect) => {
  let d: Database;
  let a: Ctx;
  let flow: DocumentFlowRepo;
  let repo: InteropRepo;
  let bundle: ImportBundle;
  const numbers: string[] = [];
  const q = (ctx: Ctx, query: SQL) => runInTx(d, ctx, (tx) => queryRows(d, tx, query));

  async function business(name: string, values: Record<string, unknown> = {}): Promise<Ctx> {
    const org = await createOrganisation(d, name);
    const base: Ctx = { orgId: org['id'], businessId: '', actor: 'tester', deviceId: 'dev' };
    const biz = await new BusinessRepo(d).create(base, {
      legal_name: name,
      state_code: '27',
      ...values,
    });
    return { ...base, businessId: biz['id'] };
  }

  async function issue(ctx: Ctx, dr: DraftDocument) {
    const r = draftToRows(dr);
    const saved = await flow.saveDraft(ctx, {
      doc: r.doc as unknown as Record<string, unknown>,
      lines: r.lines as unknown as Record<string, unknown>[],
    });
    const out = await flow.issueDraft(ctx, saved.document['id'], saved.document['version']);
    numbers.push(String(out.document['number']));
    return out.document;
  }

  const docs = async (ctx: Ctx) =>
    q(
      ctx,
      sql`SELECT type, number, party_name, total_taxable_paise, total_cgst_paise, total_sgst_paise, total_igst_paise,
                 round_off_paise, total_paise, status, metadata_json
          FROM documents WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND status = 'issued' ORDER BY type, number`,
    );

  const receivables = async (ctx: Ctx) =>
    (
      await q(
        ctx,
        sql`SELECT coalesce(sum(e.debit_paise - e.credit_paise), 0) AS v FROM ledger_entries e
            JOIN ledger_accounts a ON a.id = e.account_id
            WHERE e.business_id = ${ctx.businessId} AND a.code = 'receivables'`,
      )
    )[0]!['v'];

  beforeAll(async () => {
    d = await openTestDb(dialect);
    a = await business('Alpha Traders');
    flow = new DocumentFlowRepo(d);
    repo = new InteropRepo(d);
    const parties = new PartyRepo(d);
    const mk = async (over: Record<string, unknown>) =>
      (await parties.create(a, { type: 'both', country: 'India', ...over } as never))[
        'id'
      ] as string;
    const sharma = await mk({
      name: 'Sharma & Sons',
      type: 'customer',
      gstin: '27AAPFU0939F1ZV',
      pan: 'AAPFU0939F',
      state_code: '27',
    });
    const blr = await mk({
      name: 'Bengaluru Buyers',
      type: 'customer',
      gstin: '29AABCU9603R1ZJ',
      pan: 'AABCU9603R',
      state_code: '29',
    });
    const kumar = await mk({
      name: 'Kumar Cements',
      type: 'supplier',
      state_code: '27',
      is_unregistered: true,
    });
    const items = new ItemRepo(d);
    const cement = (
      await items.create(a, {
        kind: 'goods',
        name: 'Cement bag',
        hsn: '2523',
        gst_rate_bp: 1800,
        sale_rate_paise: 35000,
      } as never)
    )['id'] as string;

    const sales = (
      partyId: string,
      name: string,
      extra: Partial<DraftDocument>,
    ): DraftDocument => ({
      ...emptyDraft('tax_invoice', '2025-05-10', { supplierState: '27' }),
      partyId,
      partyName: name,
      ...extra,
    });
    // 1: a discount per unit and the round-off, intra-state
    await issue(
      a,
      sales(sharma, 'Sharma & Sons', {
        discountMode: 'per_unit',
        partyGstin: '27AAPFU0939F1ZV',
        partyState: '27',
        lines: [line(R(350), { itemId: cement, discountValue: 500n })],
      }),
    );
    // 2: inter-state, a service line with no item
    await issue(
      a,
      sales(blr, 'Bengaluru Buyers', {
        date: '2025-06-02',
        placeOfSupply: '29',
        partyGstin: '29AABCU9603R1ZJ',
        partyState: '29',
        lines: [line(R(1000), { description: 'Installation', hsn: '9954', qtyMicros: 1_000_000n })],
      }),
    );
    // 3: a purchase from an unregistered supplier
    await issue(a, {
      ...emptyDraft('purchase_bill', '2025-06-05', { supplierState: '27' }),
      partyId: kumar,
      partyName: 'Kumar Cements',
      partyState: '27',
      supplierInvoiceNo: 'K-77',
      supplierInvoiceDate: '2025-06-05',
      lines: [line(R(300), { itemId: cement, qtyMicros: 100_000_000n })],
    });
    // 4: a credit note
    await issue(a, {
      ...sales(sharma, 'Sharma & Sons', {
        date: '2025-07-01',
        type: 'credit_note' as DocumentType,
        partyState: '27',
      }),
      lines: [line(R(350), { itemId: cement, qtyMicros: 2_000_000n })],
    });
    await new PaymentFlowRepo(d).record(a, {
      direction: 'received',
      partyId: sharma,
      date: '2025-06-20',
      mode: 'bank',
      amountPaise: R(1000),
      reference: 'UPI 9',
      allocations: [],
    });

    const input = await repo.tallyInput(a, '2025-04-01', '2026-03-31');
    bundle = readTally(buildTallyMasters(input).xml + buildTallyVouchers(input).xml);
  }, 90_000);
  afterAll(async () => {
    await d.close();
  });

  it('reads the books into records the Tally writer can use', async () => {
    const input = await repo.tallyInput(a, '2025-04-01', '2026-03-31');
    expect(input.companyName).toBe('Alpha Traders');
    expect(input.documents.map((x) => x.type)).toEqual([
      'tax_invoice',
      'tax_invoice',
      'purchase_bill',
      'credit_note',
    ]);
    expect(input.parties).toHaveLength(3);
    const inv = input.documents[0]!;
    expect(inv.lines[0]).toMatchObject({
      itemName: 'Cement bag',
      discountPaise: R(50),
      ratePaise: R(350),
    });
    // the service line has no stock item, so it goes to the ledger only
    expect(input.documents[1]!.lines[0]!.itemName).toBeNull();
    expect(input.documents[1]).toMatchObject({ placeOfSupply: 'Karnataka' });
    expect(input.payments).toHaveLength(1);
    expect((await repo.tallyInput(a, '2024-04-01', '2025-03-31')).documents).toEqual([]);
  });

  it('plans an import into a fresh business and finds nothing to fix', async () => {
    const b = await business('Beta Traders');
    const plan = await repo.plan(b, bundle);
    expect(plan.ok).toBe(true);
    expect(plan.parties).toEqual({ create: 3, matched: 0 });
    expect(plan.items.create).toBe(1);
    expect(plan.documents.map((x) => x.action)).toEqual(['import', 'import', 'import', 'import']);
    for (const x of plan.documents) expect(x.differencePaise, x.originalNumber).toBe(0n);
    expect(plan.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    // a plan writes nothing
    expect(await docs(b)).toEqual([]);
  });

  it('round trip: every document comes back with the same totals, and the books agree', async () => {
    const b = await business('Gamma Traders');
    const r = await repo.apply(b, bundle);
    expect(r).toMatchObject({ parties: 3, items: 1, documents: 4, payments: 1, skipped: 0 });

    const before = await docs(a);
    const after = await docs(b);
    expect(after).toHaveLength(before.length);
    const pick = (x: Record<string, unknown>) => ({
      type: x['type'],
      number: x['number'],
      party: x['party_name'],
      taxable: Number(x['total_taxable_paise']),
      cgst: Number(x['total_cgst_paise']),
      sgst: Number(x['total_sgst_paise']),
      igst: Number(x['total_igst_paise']),
      round: Number(x['round_off_paise']),
      total: Number(x['total_paise']),
    });
    // purchase bills are numbered by the supplier's own number in the file, not ours
    const norm = (rows: Record<string, unknown>[]) =>
      rows
        .map(pick)
        .map((x) => ({ ...x, number: undefined }))
        .sort((p, q) => p.total - q.total);
    expect(norm(after)).toEqual(norm(before));

    // original numbers are kept for the documents that had them
    const afterNumbers = after.map((x) => String(x['number']));
    for (const n of numbers.filter((x) => !x.startsWith('PB/'))) expect(afterNumbers).toContain(n);

    // the receivables in the ledger match
    expect(Number(await receivables(b))).toBe(Number(await receivables(a)));

    // each imported document says where it came from
    const meta = after[0]!['metadata_json'] as { imported?: { source: string } } | string;
    const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
    expect(parsed.imported?.source).toBe('tally');

    // and the payment is there as party credit
    const pays = await q(
      b,
      sql`SELECT amount_paise FROM payments WHERE business_id = ${b.businessId}`,
    );
    expect(pays.map((p) => Number(p['amount_paise']))).toEqual([100000]);
  });

  it('the Imported series is not the default, so new invoices do not take from it', async () => {
    const b = await business('Delta Traders');
    await repo.apply(b, bundle);
    const rows = await q(
      b,
      sql`SELECT name, is_default, prefix FROM number_series WHERE business_id = ${b.businessId} AND document_type = 'tax_invoice' ORDER BY name`,
    );
    expect(rows.map((r) => [r['name'], !!r['is_default']])).toEqual([
      ['Default', true],
      ['Imported', false],
    ]);
    const fresh = await issue(b, {
      ...emptyDraft('tax_invoice', '2025-08-01', { supplierState: '27' }),
      partyName: 'Walk-in',
      lines: [line(R(100))],
    });
    expect(String(fresh['number'])).toMatch(/^INV\//);
  });

  it('imports the same file twice by renumbering the second run, and matches parties instead of repeating them', async () => {
    const b = await business('Epsilon Traders');
    await repo.apply(b, bundle);
    const plan = await repo.plan(b, bundle);
    expect(plan.parties).toEqual({ create: 0, matched: 3 });
    expect(plan.documents.map((x) => x.number.endsWith('/IMP'))).toEqual([true, true, true, true]);
    expect(plan.issues.some((i) => /already used here/.test(i.message))).toBe(true);
    const r = await repo.apply(b, bundle);
    expect(r).toMatchObject({ parties: 0, items: 0, documents: 4 });
    // four documents twice, and a receipt voucher for each of the two payments
    expect(await docs(b)).toHaveLength(10);
  });

  it('skips documents in a locked period and says why, and imports the rest', async () => {
    const b = await business('Zeta Traders');
    await new PeriodLockRepo(d).set(b, '2025-05-31', 'Filed');
    const plan = await repo.plan(b, bundle);
    expect(plan.documents.map((x) => x.action)).toEqual(['skip', 'import', 'import', 'import']);
    expect(plan.documents[0]!.reason).toMatch(/locked up to 2025-05-31/);
    const r = await repo.apply(b, bundle);
    expect(r).toMatchObject({ documents: 3, skipped: 1 });
  });

  it('will not import a tax invoice into a composition business', async () => {
    const b = await business('Theta Traders', { scheme: 'composition' });
    const plan = await repo.plan(b, bundle);
    expect(plan.documents[0]!.action).toBe('skip');
    expect(plan.documents[0]!.reason).toMatch(/composition/i);
    // the other documents can still be imported, so the plan can be applied
    expect(plan.ok).toBe(true);
    expect(plan.documents.filter((x) => x.action === 'skip').map((x) => x.type)).toEqual([
      'tax_invoice',
      'tax_invoice',
    ]);
  });

  it('reports a document whose total the engine does not reproduce, and imports the engine figure', async () => {
    const b = await business('Iota Traders');
    const doc: ImportDocument = {
      source: 'excel',
      ref: 'line 2',
      type: 'tax_invoice',
      number: 'X-1',
      date: '2025-05-01',
      partyName: 'Someone',
      partyGstin: '',
      placeOfSupply: '27',
      reverseCharge: false,
      narration: '',
      fileTotalPaise: R(1200),
      fileTaxPaise: null,
      lines: [
        {
          description: 'Thing',
          itemName: null,
          hsn: '',
          qtyMicros: 1_000_000n,
          unit: '',
          ratePaise: R(1000),
          discountPaise: 0n,
          taxablePaise: R(1000),
          gstRateBp: 1800,
          cessBp: 0,
        },
      ],
    };
    const plan = await repo.plan(b, {
      source: 'excel',
      parties: [],
      items: [],
      payments: [],
      issues: [],
      documents: [doc],
    });
    expect(plan.documents[0]).toMatchObject({ engineTotalPaise: R(1180), differencePaise: -R(20) });
    expect(plan.issues.map((i) => i.message).join('|')).toMatch(/the file says 12/);
    expect(plan.ok).toBe(true);
  });

  it('a unit is only added when it is one the software knows', async () => {
    const b = await business('Kappa Traders');
    const doc: ImportDocument = {
      source: 'excel',
      ref: 'line 2',
      type: 'tax_invoice',
      number: 'U-1',
      date: '2025-05-01',
      partyName: 'Someone',
      partyGstin: '',
      placeOfSupply: '27',
      reverseCharge: false,
      narration: '',
      fileTotalPaise: null,
      fileTaxPaise: null,
      lines: [
        {
          description: 'Rod',
          itemName: 'Rod',
          hsn: '7214',
          qtyMicros: 2_000_000n,
          unit: 'Kgs',
          ratePaise: R(60),
          discountPaise: 0n,
          taxablePaise: R(120),
          gstRateBp: 1800,
          cessBp: 0,
        },
      ],
    };
    const before = await q(b, sql`SELECT code FROM units WHERE business_id = ${b.businessId}`);
    await repo.apply(b, {
      source: 'excel',
      parties: [],
      items: [],
      payments: [],
      issues: [],
      documents: [doc],
    });
    const u = await q(b, sql`SELECT code FROM units WHERE business_id = ${b.businessId}`);
    // the unit is the standard one already on the books, not a new custom one
    expect(u.map((r) => String(r['code'])).filter((c) => c === 'KGS')).toEqual(['KGS']);
    expect(u.length).toBe(before.length);
  });
});
