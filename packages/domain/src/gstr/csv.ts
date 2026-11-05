/**
 * Review CSVs, one per GSTR-1 table, with the column headings of the offline tool's templates as they
 * are documented. Like the JSON layout, the headings are unverified (see data/gstn-schemas/README.md).
 */
import { toCsv, type CsvValue } from '../csv';
import { divRound, toDecimalString } from '../money';

import { gstnDate } from './period';
import type { Gstr1, GstrHsnRow, RateRow } from './types';

const n = (p: number): CsvValue => ({ numeric: toDecimalString(BigInt(p), 2) });
const rate = (bp: number): CsvValue => ({ numeric: toDecimalString(BigInt(bp), 2) });
const quantity = (micros: number): CsvValue => ({
  numeric: toDecimalString(divRound(BigInt(micros), 1000n), 3),
});
const yn = (b: boolean): string => (b ? 'Y' : 'N');

export type Gstr1CsvName =
  'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'cdnur' | 'exp' | 'exemp' | 'hsn-b2b' | 'hsn-b2c' | 'docs';

export function gstr1Csv(g: Gstr1): Record<Gstr1CsvName, string> {
  const supplierState = g.period.gstin.slice(0, 2);
  void supplierState;
  const perRate = (rows: RateRow[], head: CsvValue[], extra: CsvValue[] = []): CsvValue[][] =>
    rows.map((r) => [...head, rate(r.rateBp), n(r.txval), n(r.csamt), ...extra]);

  const b2b: CsvValue[][] = [
    [
      'GSTIN/UIN of Recipient',
      'Receiver Name',
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Place Of Supply',
      'Reverse Charge',
      'Applicable % of Tax Rate',
      'Invoice Type',
      'E-Commerce GSTIN',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  ];
  for (const p of g.b2b)
    for (const i of p.invoices)
      for (const r of i.items)
        b2b.push([
          p.ctin,
          p.name,
          i.inum,
          gstnDate(i.idt),
          n(i.val),
          i.pos,
          yn(i.rchrg),
          '',
          i.invTyp,
          '',
          rate(r.rateBp),
          n(r.txval),
          n(r.csamt),
        ]);

  const b2cl: CsvValue[][] = [
    [
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
  ];
  for (const p of g.b2cl)
    for (const i of p.invoices)
      for (const r of i.items)
        b2cl.push([
          i.inum,
          gstnDate(i.idt),
          n(i.val),
          p.pos,
          '',
          rate(r.rateBp),
          n(r.txval),
          n(r.csamt),
          '',
        ]);

  const b2cs: CsvValue[][] = [
    [
      'Type',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
    ...g.b2cs.map((r): CsvValue[] => ['OE', r.pos, '', rate(r.rateBp), n(r.txval), n(r.csamt), '']),
  ];

  const cdnr: CsvValue[][] = [
    [
      'GSTIN/UIN of Recipient',
      'Receiver Name',
      'Note Number',
      'Note Date',
      'Note Type',
      'Place Of Supply',
      'Reverse Charge',
      'Note Value',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  ];
  for (const p of g.cdnr)
    for (const x of p.notes)
      for (const r of x.items)
        cdnr.push([
          p.ctin,
          p.name,
          x.num,
          gstnDate(x.dt),
          x.ntty,
          x.pos,
          yn(x.rchrg),
          n(x.val),
          '',
          rate(r.rateBp),
          n(r.txval),
          n(r.csamt),
        ]);

  const cdnur: CsvValue[][] = [
    [
      'UR Type',
      'Note Number',
      'Note Date',
      'Note Type',
      'Place Of Supply',
      'Note Value',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  ];
  for (const x of g.cdnur)
    for (const r of x.items)
      cdnur.push([
        x.typ,
        x.num,
        gstnDate(x.dt),
        x.ntty,
        x.pos,
        n(x.val),
        '',
        rate(r.rateBp),
        n(r.txval),
        n(r.csamt),
      ]);

  const exp: CsvValue[][] = [
    [
      'Export Type',
      'Invoice Number',
      'Invoice date',
      'Invoice Value',
      'Port Code',
      'Shipping Bill Number',
      'Shipping Bill Date',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
    ],
  ];
  for (const x of g.exp)
    for (const i of x.invoices)
      exp.push(
        ...perRate(i.items, [x.expTyp, i.inum, gstnDate(i.idt), n(i.val), '', '', '', '']).map(
          (row): CsvValue[] => row,
        ),
      );

  const exemp: CsvValue[][] = [
    [
      'Description',
      'Nil Rated Supplies',
      'Exempted(other than nil rated/non GST supply)',
      'Non-GST supplies',
    ],
    ...g.nil.map((r): CsvValue[] => [
      r.splyTy === 'INTRB2B'
        ? 'Inter-State supplies to registered persons'
        : r.splyTy === 'INTRAB2B'
          ? 'Intra-State supplies to registered persons'
          : r.splyTy === 'INTRB2C'
            ? 'Inter-State supplies to unregistered persons'
            : 'Intra-State supplies to unregistered persons',
      n(r.nilAmt),
      n(r.exptAmt),
      n(r.ngsupAmt),
    ]),
  ];

  const hsnHead: CsvValue[] = [
    'HSN',
    'Description',
    'UQC',
    'Total Quantity',
    'Total Value',
    'Rate',
    'Taxable Value',
    'Integrated Tax Amount',
    'Central Tax Amount',
    'State/UT Tax Amount',
    'Cess Amount',
  ];
  const hsnRows = (rows: GstrHsnRow[]): CsvValue[][] => [
    hsnHead,
    ...rows.map((h): CsvValue[] => [
      h.hsn,
      h.description,
      h.uqc,
      quantity(h.qtyMicros),
      n(h.val),
      rate(h.rateBp),
      n(h.txval),
      n(h.iamt),
      n(h.camt),
      n(h.samt),
      n(h.csamt),
    ]),
  ];

  const docs: CsvValue[][] = [
    ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
    ...g.docs.map((r): CsvValue[] => [
      r.docTyp,
      r.from,
      r.to,
      { numeric: String(r.totnum) },
      { numeric: String(r.cancel) },
    ]),
  ];

  return {
    b2b: toCsv(b2b),
    b2cl: toCsv(b2cl),
    b2cs: toCsv(b2cs),
    cdnr: toCsv(cdnr),
    cdnur: toCsv(cdnur),
    exp: toCsv(exp),
    exemp: toCsv(exemp),
    'hsn-b2b': toCsv(hsnRows(g.hsnB2b)),
    'hsn-b2c': toCsv(hsnRows(g.hsnB2c)),
    docs: toCsv(docs),
  };
}
