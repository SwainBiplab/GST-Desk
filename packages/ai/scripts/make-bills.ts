/**
 * The golden set: synthetic purchase bills in the layouts Indian suppliers print, with the exact fields
 * they hold. Deterministic (seeded), so the files only change when this script does. Real, anonymised
 * scans go beside them in `fixtures/bills/real/` with the same JSON shape plus an `image` path.
 *
 *   pnpm --filter @gst/ai exec tsx scripts/make-bills.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { gstinCheckChar } from '@gst/domain';

const out = join(import.meta.dirname, '..', 'fixtures', 'bills');
mkdirSync(out, { recursive: true });

let seed = 20261107;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

const SUPPLIERS = [
  { name: 'Shree Ganesh Traders', state: '27', pan: 'AAPFU0939F', city: 'Pune' },
  { name: 'Kumar Electricals', state: '33', pan: 'AAACK1234K', city: 'Chennai' },
  { name: 'Patel Hardware Mart', state: '24', pan: 'ABCPP4567Q', city: 'Surat' },
  { name: 'Bharat Steel Industries Pvt Ltd', state: '27', pan: 'AABCB7788M', city: 'Nashik' },
  { name: 'Mehta & Sons', state: '07', pan: 'AAEFM2211R', city: 'Delhi' },
  { name: 'Lakshmi Agencies', state: '29', pan: 'AADFL9087D', city: 'Bengaluru' },
  { name: 'Verma Plastics', state: '09', pan: 'AAGCV5634P', city: 'Kanpur' },
  { name: 'Sri Murugan Stores', state: '33', pan: 'AAFPS1122E', city: 'Madurai' },
  { name: 'Roy Paper Products', state: '19', pan: 'AABPR3344C', city: 'Kolkata' },
  { name: 'Desai Textiles', state: '24', pan: 'AAHPD6655L', city: 'Ahmedabad' },
];
const ITEMS = [
  { d: 'Cement OPC 53 50kg', hsn: '2523', rate: 380, gst: 28 },
  { d: 'TMT Bar 12mm', hsn: '7214', rate: 62.5, gst: 18 },
  { d: 'Wire 1.5 sqmm 90m', hsn: '8544', rate: 1250, gst: 18 },
  { d: 'Switch 6A', hsn: '8536', rate: 45, gst: 18 },
  { d: 'A4 Copier Paper 75gsm', hsn: '4802', rate: 285, gst: 12 },
  { d: 'Ball Pen Blue', hsn: '9608', rate: 5, gst: 18 },
  { d: 'Plastic Bucket 20L', hsn: '3924', rate: 140, gst: 18 },
  { d: 'LED Bulb 9W', hsn: '8539', rate: 85, gst: 12 },
  { d: 'Cotton Shirting 1.2m', hsn: '5208', rate: 210, gst: 5 },
  { d: 'Sugar 50kg', hsn: '1701', rate: 2050, gst: 5 },
  { d: 'Paint Brush 2 inch', hsn: '9603', rate: 25, gst: 18 },
  { d: 'Mobile Charger 20W', hsn: '8504', rate: 399, gst: 18 },
  { d: 'Packing Tape 48mm', hsn: '3919', rate: 38, gst: 18 },
  { d: 'Steel Pipe 1 inch', hsn: '7306', rate: 520, gst: 18 },
  { d: 'Floor Cleaner 5L', hsn: '3402', rate: 310, gst: 18 },
];
const OWN = { name: 'Our Shop', gstin: gstin('27', 'AABCU9603R') };
const money = (n: number) => n.toFixed(2);
const pad = (s: string, n: number) => s.padEnd(n);

interface Line {
  description: string;
  hsn: string;
  qty: number;
  ratePaise: number;
  gstRateBp: number;
}

function bill(i: number) {
  const s = pick(SUPPLIERS);
  const g = gstin(s.state, s.pan);
  const inter = s.state !== '27';
  const n = int(1, 5);
  const lines: Line[] = [];
  const used = new Set<number>();
  while (lines.length < n) {
    const k = int(0, ITEMS.length - 1);
    if (used.has(k)) continue;
    used.add(k);
    const it = ITEMS[k]!;
    lines.push({
      description: it.d,
      hsn: it.hsn,
      qty: int(1, 60),
      ratePaise: Math.round(it.rate * 100),
      gstRateBp: it.gst * 100,
    });
  }
  const d = new Date(Date.UTC(2026, int(0, 9), int(1, 28)));
  const iso = d.toISOString().slice(0, 10);
  const [y, m, dd] = iso.split('-') as [string, string, string];
  const dateText = pick([
    `${dd}/${m}/${y}`,
    `${dd}-${m}-${y}`,
    `${dd}.${m}.${y}`,
    `${Number(dd)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`,
    iso,
  ]);
  const number = pick([
    `${s.name.split(' ')[0]!.slice(0, 3).toUpperCase()}/${y.slice(2)}-${Number(y.slice(2)) + 1}/${String(int(1, 999)).padStart(4, '0')}`,
    `INV-${int(100, 9999)}`,
    `${int(1, 999)}`,
    `B${int(1000, 99999)}`,
  ]);
  const taxable = lines.reduce((a, l) => a + (l.qty * l.ratePaise) / 100, 0);
  const byRate = new Map<number, number>();
  for (const l of lines)
    byRate.set(l.gstRateBp, (byRate.get(l.gstRateBp) ?? 0) + (l.qty * l.ratePaise) / 100);
  let tax = 0;
  const taxLines: string[] = [];
  for (const [bp, base] of [...byRate.entries()].sort((a, b) => a[0] - b[0])) {
    const t = Math.round(base * bp) / 10000;
    tax += t;
    if (inter) taxLines.push(`IGST ${bp / 100}%${' '.repeat(40)}${money(t)}`);
    else {
      taxLines.push(`CGST ${bp / 200}%${' '.repeat(40)}${money(t / 2)}`);
      taxLines.push(`SGST ${bp / 200}%${' '.repeat(40)}${money(t / 2)}`);
    }
  }
  const exact = taxable + tax;
  const total = Math.round(exact);
  const roundOff = total - exact;
  const layout = i % 4;
  const rows: string[] = [];
  const title = pick([
    'TAX INVOICE',
    'Tax Invoice',
    'TAX INVOICE  (Original for Recipient)',
    'INVOICE',
  ]);
  if (layout === 0) {
    rows.push(
      s.name.toUpperCase(),
      `${int(1, 99)}, ${pick(['Market Road', 'MG Road', 'Station Road', 'Industrial Estate'])}, ${s.city}`,
      `GSTIN: ${g}   Phone: 9${int(100000000, 999999999)}`,
      title,
      `Invoice No: ${number}        Date: ${dateText}`,
      `Bill To: ${OWN.name}, GSTIN ${OWN.gstin}`,
      `${pad('S.No', 6)}${pad('Description', 26)}${pad('HSN', 6)}${pad('Qty', 6)}${pad('Rate', 10)}Amount`,
    );
    lines.forEach((l, k) =>
      rows.push(
        `${pad(String(k + 1), 6)}${pad(l.description, 26)}${pad(l.hsn, 6)}${pad(String(l.qty), 6)}${pad(money(l.ratePaise / 100), 10)}${money((l.qty * l.ratePaise) / 100)}`,
      ),
    );
    rows.push(`Sub Total${' '.repeat(44)}${money(taxable)}`, ...taxLines);
    if (Math.abs(roundOff) >= 0.005)
      rows.push(
        `Round Off${' '.repeat(44)}${roundOff >= 0 ? '' : '-'}${money(Math.abs(roundOff))}`,
      );
    rows.push(`Grand Total${' '.repeat(42)}${money(total)}`, 'E.&O.E.   Authorised Signatory');
  } else if (layout === 1) {
    rows.push(s.name, `Invoice No. ${number} dt ${dateText}`, `GST No ${g}`, `State: ${s.state}`);
    lines.forEach((l) =>
      rows.push(
        `${pad(l.description, 24)}${l.qty}   ${money(l.ratePaise / 100)}   ${money((l.qty * l.ratePaise) / 100)}`,
      ),
    );
    rows.push(...taxLines, `Total ${money(total)}`);
  } else if (layout === 2) {
    rows.push(
      title,
      `M/s ${s.name}`,
      `${s.city}`,
      `GSTIN/UIN: ${g}`,
      `Buyer: ${OWN.name} (${OWN.gstin})`,
      `Invoice No.: ${number}`,
      `Dated: ${dateText}`,
      `${pad('Sl', 4)}${pad('Particulars', 28)}${pad('HSN/SAC', 9)}${pad('GST Rate', 10)}${pad('Quantity', 10)}${pad('Rate', 10)}Amount`,
    );
    lines.forEach((l, k) =>
      rows.push(
        `${pad(String(k + 1), 4)}${pad(l.description, 28)}${pad(l.hsn, 9)}${pad(`${l.gstRateBp / 100}%`, 10)}${pad(`${l.qty} Nos`, 10)}${pad(money(l.ratePaise / 100), 10)}${money((l.qty * l.ratePaise) / 100)}`,
      ),
    );
    rows.push(
      `${' '.repeat(50)}Taxable Value  ${money(taxable)}`,
      ...taxLines.map((t) => `${' '.repeat(10)}${t}`),
      `${' '.repeat(50)}Total Amount   ${money(total)}`,
      `Amount Chargeable (in words): Rupees ${total} Only`,
      'Declaration: Goods once sold will not be taken back.',
      'for ' + s.name,
      'Authorised Signatory',
    );
  } else {
    rows.push(
      `${s.name}  ${s.city}`,
      `gstin ${g.toLowerCase()}`,
      `bill no ${number}  date ${dateText}`,
      `${pad('Item', 26)}${pad('Qty', 5)}${pad('Rate', 10)}Amt`,
    );
    lines.forEach((l) =>
      rows.push(
        `${pad(l.description, 26)}${pad(String(l.qty), 5)}${pad(money(l.ratePaise / 100), 10)}${money((l.qty * l.ratePaise) / 100)}`,
      ),
    );
    rows.push(
      ...taxLines.map((t) => t.toLowerCase()),
      `net amount ${money(total)}`,
      'thank you visit again',
    );
  }
  return {
    name: `bill-${String(i + 1).padStart(3, '0')}`,
    input: { kind: 'text', text: rows.join('\n') },
    expected: {
      supplierName:
        layout === 0
          ? s.name.toUpperCase()
          : layout === 2
            ? `M/s ${s.name}`
            : layout === 3
              ? `${s.name}  ${s.city}`.replace(/\s{2,}.*$/, '')
              : s.name,
      supplierGstin: g,
      invoiceNumber: number,
      date: iso,
      lines: lines.map((l) => ({ ...l, hsn: layout === 1 || layout === 3 ? null : l.hsn })),
      totalPaise: total * 100,
    },
    meta: {
      layout: ['header-table', 'plain', 'tally-style', 'lowercase-retail'][layout],
      interState: inter,
      lines: n,
    },
  };
}

const COUNT = 60;
for (let i = 0; i < COUNT; i++) {
  const b = bill(i);
  writeFileSync(join(out, `${b.name}.json`), JSON.stringify(b, null, 2) + '\n');
}
console.log(`wrote ${COUNT} bills to ${out}`);
