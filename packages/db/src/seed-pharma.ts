/**
 * A pharma-style set of stock for a business (prompt 51): medicines tracked by batch with expiry
 * (some close to it), a serial-tracked device, two godowns, a supplier and a customer, purchases that
 * create the batches, sales that pick first-expiry-first, a return and an adjustment, all through the
 * repositories so the valuation and the ledger postings are the real ones. Used by the tests and
 * available to the demo (`?demo=1&pharma=1`).
 */
import {
  draftToRows,
  emptyDraft,
  emptyDraftLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';

import type { Database } from './database';
import type { Ctx } from './repositories/base';
import { BatchRepo } from './repositories/batches';
import { DocumentFlowRepo } from './repositories/document-flow';
import { GodownRepo, TransferRepo } from './repositories/godowns';
import { InventoryRepo } from './repositories/inventory';
import { ItemRepo } from './repositories/items';
import { PartyRepo } from './repositories/parties';
import { ValuationRepo } from './repositories/valuation';

export interface PharmaSeed {
  supplierId: string;
  customerId: string;
  godowns: { main: string; cold: string };
  items: Record<'paracetamol' | 'amoxicillin' | 'insulin' | 'glucometer', string>;
  batches: Record<'pcmA' | 'pcmB' | 'amxA' | 'insA', string>;
  documents: Record<string, string>;
  transferId: string;
}

const units = (n: number) => BigInt(Math.round(n * 1_000_000));
let k = 0;
const line = (over: Partial<DraftLine>): DraftLine => ({
  ...emptyDraftLine(`ph${++k}`),
  qtyMicros: 1_000_000n,
  gstRateBp: 1200,
  hsn: '3004',
  ...over,
});

/** Seed the stock; dates are relative to `today` so the expiry alerts fire. */
export async function seedPharma(
  d: Database,
  ctx: Ctx,
  opts: { today: string; method?: 'fifo' | 'wavg' | null } = { today: '2026-11-01' },
): Promise<PharmaSeed> {
  const day = (offset: number): string =>
    new Date(Date.parse(`${opts.today}T00:00:00Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const items = new ItemRepo(d);
  const parties = new PartyRepo(d);
  const batches = new BatchRepo(d);
  const flow = new DocumentFlowRepo(d);
  const godowns = new GodownRepo(d);

  if (opts.method !== null)
    await new ValuationRepo(d).set(ctx, opts.method ?? 'fifo', { today: day(-120) });

  const main = (await godowns.defaultId(ctx)) ?? (await godowns.add(ctx, { name: 'Main' })).id;
  const cold = (await godowns.add(ctx, { name: 'Cold storage', code: 'COLD' })).id;

  const supplierId = (
    await parties.create(ctx, { type: 'supplier', name: 'Medplus Distributors', state_code: '27' })
  )['id'];
  const customerId = (
    await parties.create(ctx, { type: 'customer', name: 'Sharma Medical Stores', state_code: '27' })
  )['id'];

  const base = {
    kind: 'goods',
    hsn: '3004',
    gst_rate_bp: 1200,
    track_stock: true,
    tracking_mode: 'batch',
    expiry_required: true,
  };
  const paracetamol = (
    await items.create(ctx, {
      ...base,
      name: 'Paracetamol 500 mg (strip of 10)',
      sku: 'PCM-500',
      sale_rate_paise: 3000,
      purchase_rate_paise: 2000,
      min_stock_micros: 50_000_000,
    })
  )['id'];
  const amoxicillin = (
    await items.create(ctx, {
      ...base,
      name: 'Amoxicillin 250 mg (strip of 10)',
      sku: 'AMX-250',
      sale_rate_paise: 9000,
      purchase_rate_paise: 6000,
    })
  )['id'];
  const insulin = (
    await items.create(ctx, {
      ...base,
      name: 'Insulin glargine 100 IU/ml',
      sku: 'INS-GLA',
      sale_rate_paise: 80000,
      purchase_rate_paise: 60000,
      default_godown_id: cold,
    })
  )['id'];
  const glucometer = (
    await items.create(ctx, {
      kind: 'goods',
      hsn: '9027',
      gst_rate_bp: 1200,
      track_stock: true,
      tracking_mode: 'serial',
      name: 'Glucometer',
      sku: 'GLU-01',
      sale_rate_paise: 150000,
      purchase_rate_paise: 100000,
    })
  )['id'];

  // the batches the purchases bring in: two of paracetamol (one near expiry), one each of the rest
  const b = async (itemId: string, batchNo: string, expiry: string, mrp: number) =>
    (
      await batches.ensure(ctx, {
        itemId,
        batchNo,
        expiryDate: expiry,
        mfgDate: day(-200),
        mrpPaise: mrp,
      })
    ).id;
  const pcmA = await b(paracetamol, 'PCM-A24', day(45), 3500);
  const pcmB = await b(paracetamol, 'PCM-B25', day(400), 3500);
  const amxA = await b(amoxicillin, 'AMX-A24', day(20), 11000);
  const insA = await b(insulin, 'INS-A25', day(300), 95000);

  const issue = async (name: string, dr: DraftDocument) => {
    const rows = draftToRows(dr);
    const saved = await flow.saveDraft(ctx, {
      doc: rows.doc as unknown as Record<string, unknown>,
      lines: rows.lines as unknown as Record<string, unknown>[],
    });
    const r = await flow.issueDraft(ctx, saved.document['id'], saved.document['version'], {
      inventoryEnabled: true,
    });
    documents[name] = r.document['id'];
    return r;
  };
  const documents: Record<string, string> = {};
  const purchase = (date: string, no: string, lines: DraftLine[]): DraftDocument => ({
    ...emptyDraft('purchase_bill', date, { supplierState: '27' }),
    partyId: supplierId,
    supplierInvoiceNo: no,
    supplierInvoiceDate: date,
    lines,
  });
  const sale = (
    date: string,
    lines: DraftLine[],
    type: 'tax_invoice' | 'credit_note' = 'tax_invoice',
  ): DraftDocument => ({
    ...emptyDraft(type, date, { supplierState: '27' }),
    partyId: customerId,
    lines,
  });

  // purchases: paracetamol twice at different costs, the rest once, the glucometers with serials
  await issue(
    'purchase1',
    purchase(day(-90), 'MP/1001', [
      line({
        itemId: paracetamol,
        description: 'Paracetamol 500 mg',
        qtyMicros: units(100),
        ratePaise: 2000n,
        batchId: pcmA,
      }),
      line({
        itemId: amoxicillin,
        description: 'Amoxicillin 250 mg',
        qtyMicros: units(40),
        ratePaise: 6000n,
        batchId: amxA,
      }),
      line({
        itemId: insulin,
        description: 'Insulin glargine',
        qtyMicros: units(10),
        ratePaise: 60000n,
        batchId: insA,
        godownId: cold,
      }),
    ]),
  );
  await issue(
    'purchase2',
    purchase(day(-60), 'MP/1042', [
      line({
        itemId: paracetamol,
        description: 'Paracetamol 500 mg',
        qtyMicros: units(100),
        ratePaise: 2400n,
        batchId: pcmB,
      }),
      line({
        itemId: glucometer,
        description: 'Glucometer',
        hsn: '9027',
        qtyMicros: units(5),
        ratePaise: 100000n,
        serials: ['GM-0001', 'GM-0002', 'GM-0003', 'GM-0004', 'GM-0005'],
      }),
    ]),
  );
  // sales: the paracetamol line names no batch, so first expiry goes first
  await issue(
    'sale1',
    sale(day(-30), [
      line({
        itemId: paracetamol,
        description: 'Paracetamol 500 mg',
        qtyMicros: units(120),
        ratePaise: 3000n,
      }),
      line({
        itemId: glucometer,
        description: 'Glucometer',
        hsn: '9027',
        qtyMicros: units(2),
        ratePaise: 150000n,
        serials: ['GM-0001', 'GM-0002'],
      }),
    ]),
  );
  await issue(
    'sale2',
    sale(day(-10), [
      line({
        itemId: amoxicillin,
        description: 'Amoxicillin 250 mg',
        qtyMicros: units(15),
        ratePaise: 9000n,
        batchId: amxA,
      }),
      line({
        itemId: insulin,
        description: 'Insulin glargine',
        qtyMicros: units(3),
        ratePaise: 80000n,
        batchId: insA,
        godownId: cold,
      }),
    ]),
  );
  // a return: one glucometer comes back
  await issue(
    'return1',
    sale(
      day(-5),
      [
        line({
          itemId: glucometer,
          description: 'Glucometer',
          hsn: '9027',
          qtyMicros: units(1),
          ratePaise: 150000n,
          serials: ['GM-0002'],
        }),
      ],
      'credit_note',
    ),
  );
  // two strips of amoxicillin were damaged
  await new InventoryRepo(d).adjust(ctx, {
    date: day(-3),
    reason: 'damage',
    note: 'Water damage in transit',
    lines: [{ itemId: amoxicillin, deltaMicros: -2_000_000, batchId: amxA }],
  });
  // some paracetamol moves to the cold store, received the next day
  const transfer = await new TransferRepo(d).dispatch(ctx, {
    date: day(-2),
    fromGodownId: main,
    toGodownId: cold,
    lines: [{ itemId: paracetamol, batchId: pcmB, qtyMicros: 20_000_000 }],
  });
  await new TransferRepo(d).receive(ctx, transfer.id, transfer.version, day(-1));
  // one last sale, so the document count says when the whole seed is in (the demo loader and the
  // e2e helper wait for it)
  await issue(
    'sale3',
    sale(day(0), [
      line({
        itemId: amoxicillin,
        description: 'Amoxicillin 250 mg',
        qtyMicros: units(1),
        ratePaise: 9000n,
        batchId: amxA,
      }),
    ]),
  );

  return {
    supplierId,
    customerId,
    godowns: { main, cold },
    items: { paracetamol, amoxicillin, insulin, glucometer },
    batches: { pcmA, pcmB, amxA, insA },
    documents,
    transferId: transfer.id,
  };
}
