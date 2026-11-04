/**
 * Deterministic demo data: one business, 50 parties, 200 items, 500 documents over two
 * financial years, payments and stock. Same seed => byte-identical rows (ids and timestamps included).
 * Bulk-inserts directly (no per-row audit_log), inside one transaction.
 */
import { withCheckDigit } from '@gst/domain';
import { sql } from 'drizzle-orm';

import type { Database } from './database';
import { BusinessRepo, createOrganisation, createUser } from './repositories/aggregates';
import type { Ctx } from './repositories/base';
import { computeLine, computeTotals } from './repositories/line-math';
import type { Row } from './schema';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinFor(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CHARS.indexOf(first14.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return first14 + CHARS.charAt((36 - (sum % 36)) % 36);
}

const FIRST = [
  'Sharma',
  'Iyer',
  'Das',
  'Patel',
  'Reddy',
  'Khan',
  'Singh',
  'Nair',
  'Gupta',
  'Mehta',
  'Joshi',
  'Bose',
  'Rao',
  'Shah',
  'Verma',
];
const SECOND = [
  'Traders',
  'Enterprises',
  'Stores',
  'Agencies',
  'Industries',
  'Distributors',
  'Mart',
  'Supplies',
  'Works',
  'Sons',
];
const CITIES = [
  'Mumbai',
  'Pune',
  'Bengaluru',
  'Chennai',
  'Ahmedabad',
  'Kolkata',
  'Hyderabad',
  'Delhi',
];
const ITEM_A = [
  'Copper',
  'Steel',
  'Cotton',
  'Plastic',
  'Paper',
  'Rubber',
  'Glass',
  'Wooden',
  'Cable',
  'Ceramic',
];
const ITEM_B = [
  'Wire',
  'Pipe',
  'Sheet',
  'Bolt',
  'Roll',
  'Box',
  'Panel',
  'Fitting',
  'Tape',
  'Valve',
];
const STATES = ['27', '27', '27', '29', '24', '33', '07', '19'];
const HSN = ['7408', '7306', '5208', '3923', '4802', '4016', '7010', '9403', '8544', '6907'];
const GST_BP = [0, 500, 1200, 1800, 1800, 1800, 2800];

const DOC_MIX: [string, number][] = [
  ['tax_invoice', 55],
  ['purchase_bill', 15],
  ['quotation', 8],
  ['credit_note', 5],
  ['bill_of_supply', 5],
  ['debit_note', 3],
  ['proforma', 3],
  ['delivery_challan', 3],
  ['expense', 3],
];
const PREFIX: Record<string, string> = {
  tax_invoice: 'INV',
  purchase_bill: 'PB',
  quotation: 'QT',
  credit_note: 'CN',
  bill_of_supply: 'BOS',
  debit_note: 'DN',
  proforma: 'PI',
  delivery_challan: 'DC',
  expense: 'EXP',
};

export interface SeedOptions {
  seed?: number;
  parties?: number;
  items?: number;
  documents?: number;
  /** Add one extra party with this many issued invoices (used to test Party 360 at scale). */
  heavyParty?: number;
}

export interface SeedResult {
  ctx: Ctx;
  counts: Record<string, number>;
}

const EPOCH = Date.UTC(2024, 3, 1);
const DAY = 86_400_000;

async function chunked(tx: any, table: any, rows: Row[], size = 100) {
  for (let i = 0; i < rows.length; i += size)
    await tx.insert(table).values(rows.slice(i, i + size));
}

export async function seedDemo(d: Database, opts: SeedOptions = {}): Promise<SeedResult> {
  const rnd = mulberry32(opts.seed ?? 20260401);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => Math.floor(rnd() * 16).toString(16));
    h[12] = '4';
    h[16] = '89ab'[Math.floor(rnd() * 4)]!;
    return `${h.slice(0, 8).join('')}-${h.slice(8, 12).join('')}-${h.slice(12, 16).join('')}-${h.slice(16, 20).join('')}-${h.slice(20).join('')}`;
  };

  const org = await createOrganisation(d, 'Demo Org');
  const user = await createUser(d, { email: 'demo@gstdesk.local', name: 'Demo Owner' });
  const base: Ctx = { orgId: org['id'], businessId: '', actor: user['id'], deviceId: 'seed' };
  const biz = await new BusinessRepo(d).create(base, {
    legal_name: 'Demo Traders Pvt Ltd',
    trade_name: 'Demo Traders',
    gstin: gstinFor('27AABCD1234E1Z'),
    state_code: '27',
    pan: 'AABCD1234E',
  });
  const ctx: Ctx = { ...base, businessId: biz['id'] };
  const s = d.schema;

  const stamp = (offsetDays = 0) => ({
    id: uuid(),
    org_id: ctx.orgId,
    business_id: ctx.businessId,
    version: 1,
    created_at: EPOCH + offsetDays * DAY,
    updated_at: EPOCH + offsetDays * DAY,
    created_by: ctx.actor,
    updated_by: ctx.actor,
  });

  const counts: Record<string, number> = {};
  await d.db.transaction(async (tx: any) => {
    if (d.dialect === 'pg')
      await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.orgId}, true)`);
    const units: Row[] = await tx.select().from(s.units);
    const godown: Row = (await tx.select().from(s.godowns))[0];
    const nos = units.find((u) => u['code'] === 'NOS')!;

    const parties: Row[] = Array.from({ length: opts.parties ?? 50 }, (_, i) => {
      const state = pick(STATES);
      const pan = `AAA${'PCFH'[i % 4]}${String.fromCharCode(65 + (i % 26))}${String(1000 + i)}${String.fromCharCode(65 + ((i * 7) % 26))}`;
      return {
        ...stamp(i % 30),
        type: i % 5 === 0 ? 'supplier' : i % 11 === 0 ? 'both' : 'customer',
        name: `${pick(FIRST)} ${pick(SECOND)} ${i + 1}`,
        gstin: i % 9 === 8 ? null : gstinFor(`${state}${pan}1Z`),
        pan,
        phone: `98${String(int(10000000, 99999999))}`,
        city: pick(CITIES),
        country: 'India',
        state_code: state,
        credit_days: pick([0, 15, 30, 45]),
        opening_balance_paise: 0,
        is_unregistered: i % 9 === 8,
      };
    });
    await chunked(tx, s.parties, parties);
    counts['parties'] = parties.length;

    const items: Row[] = Array.from({ length: opts.items ?? 200 }, (_, i) => ({
      ...stamp(i % 30),
      kind: i % 10 === 9 ? 'service' : 'goods',
      name: `${pick(ITEM_A)} ${pick(ITEM_B)} ${i + 1}`,
      sku: `SKU-${String(i + 1).padStart(4, '0')}`,
      barcode: withCheckDigit(`890${String(100000000 + i * 7919).padStart(9, '0')}`),
      hsn: pick(HSN),
      unit_id: nos['id'],
      sale_rate_paise: int(50, 5000) * 100,
      purchase_rate_paise: int(30, 3000) * 100,
      gst_rate_bp: pick(GST_BP),
      track_stock: i % 10 !== 9,
    }));
    await chunked(tx, s.items, items);
    counts['items'] = items.length;

    // opening stock
    const stock: Row[] = items
      .filter((it) => it['track_stock'])
      .map((it) => ({
        ...stamp(0),
        item_id: it['id'],
        godown_id: godown['id'],
        kind: 'in',
        qty_micros: int(50, 500) * 1_000_000,
        rate_paise: it['purchase_rate_paise'],
        date: '2024-04-01',
        note: 'Opening stock',
      }));

    // number series (one per type and FY) and sequential counters
    const counters = new Map<string, number>();
    const seriesRows: Row[] = [];
    const seriesId = new Map<string, string>();
    for (const [type] of DOC_MIX) {
      for (const fy of ['24-25', '25-26']) {
        const row = {
          ...stamp(0),
          document_type: type,
          prefix: `${PREFIX[type]}/${fy}/`,
          fy,
          padding: 4,
          next_number: 1,
        };
        seriesRows.push(row);
        seriesId.set(`${type}|${fy}`, row.id);
      }
    }

    const docs: Row[] = [];
    const lineRows: Row[] = [];
    const paymentRows: Row[] = [];
    const allocRows: Row[] = [];
    const total = opts.documents ?? 500;

    const heavy = opts.heavyParty ?? 0;
    let heavyParty: Row | undefined;
    if (heavy > 0) {
      heavyParty = {
        ...stamp(0),
        type: 'customer',
        name: 'Heavy Traders',
        gstin: gstinFor('27AAHCH1234H1Z'.slice(0, 14)),
        state_code: '27',
        city: 'Mumbai',
        country: 'India',
        credit_days: 30,
      };
      await chunked(tx, s.parties, [heavyParty]);
      parties.push(heavyParty);
    }
    for (let n = 0; n < total + heavy; n++) {
      const isHeavy = n >= total;
      const dayOffset = isHeavy
        ? Math.floor(((n - total) / heavy) * 730)
        : Math.floor((n / total) * 730);
      const dateMs = EPOCH + dayOffset * DAY;
      const date = new Date(dateMs).toISOString().slice(0, 10);
      const fy = dayOffset < 365 ? '24-25' : '25-26';
      let roll = int(1, 100);
      const type = isHeavy ? 'tax_invoice' : DOC_MIX.find(([, w]) => (roll -= w) <= 0)![0];
      const party = isHeavy ? heavyParty! : pick(parties);
      const supply = party['state_code'] === '27' ? 'intra' : 'inter';
      const sr = rnd();
      const status = isHeavy ? 'issued' : sr < 0.1 ? 'draft' : sr < 0.15 ? 'cancelled' : 'issued';
      const docId = uuid();

      const nLines = int(1, 5);
      const lines: Row[] = Array.from({ length: nLines }, (_, li) => {
        const it = pick(items);
        const gst = it['gst_rate_bp'] as number;
        const intra = supply === 'intra';
        const draft = {
          qty_micros: int(1, 20) * 1_000_000,
          rate_paise: type === 'purchase_bill' ? it['purchase_rate_paise'] : it['sale_rate_paise'],
          discount_mode: rnd() < 0.2 ? 'percent' : 'none',
          discount_value: 0,
          cgst_bp: intra ? gst / 2 : 0,
          sgst_bp: intra ? gst / 2 : 0,
          igst_bp: intra ? 0 : gst,
          utgst_bp: 0,
          cess_bp: 0,
        };
        if (draft.discount_mode === 'percent') draft.discount_value = pick([500, 1000]);
        return {
          ...stamp(dayOffset),
          document_id: docId,
          line_no: li + 1,
          item_id: it['id'],
          description: it['name'],
          hsn: it['hsn'],
          unit_id: nos['id'],
          ...draft,
          ...computeLine(draft),
        };
      });

      const sums = computeTotals({ tcs_paise: 0, round_off_paise: 0 }, lines);
      const roundOff = Math.round(sums.total_paise / 100) * 100 - sums.total_paise;
      const totals = computeTotals({ tcs_paise: 0, round_off_paise: roundOff }, lines);

      let number: string | null = null;
      if (status !== 'draft') {
        const key = `${type}|${fy}`;
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        number = `${PREFIX[type]}/${fy}/${String(next).padStart(4, '0')}`;
      }

      docs.push({
        ...stamp(dayOffset),
        id: docId,
        type,
        status,
        number,
        series_id: seriesId.get(`${type}|${fy}`),
        date,
        due_date: new Date(dateMs + (party['credit_days'] as number) * DAY)
          .toISOString()
          .slice(0, 10),
        party_id: party['id'],
        party_name: party['name'],
        place_of_supply_state: party['state_code'],
        supply_type: supply,
        ...totals,
        round_off_paise: roundOff,
        cancelled_at: status === 'cancelled' ? dateMs + DAY : null,
        cancel_reason: status === 'cancelled' ? 'Entered in error' : null,
      });
      lineRows.push(...lines);

      const moves = status === 'issued' && (type === 'tax_invoice' || type === 'purchase_bill');
      if (moves) {
        for (const l of lines) {
          const it = items.find((x) => x['id'] === l['item_id'])!;
          if (!it['track_stock']) continue;
          stock.push({
            ...stamp(dayOffset),
            item_id: it['id'],
            godown_id: godown['id'],
            kind: type === 'tax_invoice' ? 'out' : 'in',
            qty_micros: (type === 'tax_invoice' ? -1 : 1) * (l['qty_micros'] as number),
            rate_paise: l['rate_paise'],
            document_id: docId,
            date,
          });
        }
        if (rnd() < 0.6) {
          const amount =
            rnd() < 0.7 ? totals.total_paise : Math.floor(totals.total_paise / 2 / 100) * 100;
          if (amount > 0) {
            const payment = {
              ...stamp(dayOffset + 3),
              date: new Date(dateMs + 3 * DAY).toISOString().slice(0, 10),
              direction: type === 'purchase_bill' ? 'made' : 'received',
              mode: pick(['cash', 'upi', 'bank', 'cheque']),
              party_id: party['id'],
              amount_paise: amount,
              reference: `REF${n}`,
              status: 'cleared',
            };
            paymentRows.push(payment);
            allocRows.push({
              ...stamp(dayOffset + 3),
              payment_id: payment.id,
              document_id: docId,
              amount_paise: amount,
              kind: 'payment',
            });
          }
        }
      }
    }

    for (const sr of seriesRows) {
      const key = `${sr['document_type']}|${sr['fy']}`;
      sr['next_number'] = (counters.get(key) ?? 0) + 1;
    }
    await chunked(tx, s.number_series, seriesRows);
    await chunked(tx, s.documents, docs, 50);
    await chunked(tx, s.document_lines, lineRows, 50);
    await chunked(tx, s.payments, paymentRows);
    await chunked(tx, s.payment_allocations, allocRows);
    await chunked(tx, s.stock_movements, stock);
    Object.assign(counts, {
      documents: docs.length,
      document_lines: lineRows.length,
      payments: paymentRows.length,
      stock_movements: stock.length,
    });
  });
  return { ctx, counts };
}
