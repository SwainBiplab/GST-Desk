/**
 * Tally XML out: masters (party ledgers, stock items, units, GST ledgers) and vouchers (sales,
 * purchases, credit and debit notes, receipts and payments) as a TallyPrime import envelope, from plain
 * records. The round-off goes inside each voucher as its own ledger line, the way Tally books it.
 *
 * STATUS: written from the public documentation of Tally's XML import. It has NOT been imported into a
 * TallyPrime instance. See docs/compliance/tally-interop.md.
 */
import { STATES, toDecimalString, type DocumentType } from '@gst/domain';

import { el, txt, type XmlChild } from './xml';

/** The ledger names the export uses. A business that already has its own names can change them. */
export interface TallyNames {
  sales: string;
  purchases: string;
  roundOff: string;
  outputCgst: string;
  outputSgst: string;
  outputUtgst: string;
  outputIgst: string;
  outputCess: string;
  inputCgst: string;
  inputSgst: string;
  inputUtgst: string;
  inputIgst: string;
  inputCess: string;
  cash: string;
  bank: string;
  tcs: string;
}

export const DEFAULT_TALLY_NAMES: TallyNames = {
  sales: 'Sales',
  purchases: 'Purchases',
  roundOff: 'Round Off',
  outputCgst: 'Output CGST',
  outputSgst: 'Output SGST',
  outputUtgst: 'Output UTGST',
  outputIgst: 'Output IGST',
  outputCess: 'Output Cess',
  inputCgst: 'Input CGST',
  inputSgst: 'Input SGST',
  inputUtgst: 'Input UTGST',
  inputIgst: 'Input IGST',
  inputCess: 'Input Cess',
  cash: 'Cash',
  bank: 'Bank Account',
  tcs: 'TCS Payable',
};

export interface TallyParty {
  name: string;
  type: 'customer' | 'supplier' | 'both';
  gstin: string;
  pan: string;
  stateCode: string;
  addressLines: string[];
  pincode: string;
  country: string;
  registration: 'Regular' | 'Unregistered' | 'Composition';
}

export interface TallyItem {
  name: string;
  hsn: string;
  unit: string;
  /** Total GST rate in basis points. */
  gstRateBp: number;
  description: string;
}

export interface TallyLine {
  description: string;
  /** The stock item it is booked against; null for a service line, which goes to the ledger only. */
  itemName: string | null;
  hsn: string;
  qtyMicros: bigint;
  unit: string;
  ratePaise: bigint;
  discountPaise: bigint;
  taxablePaise: bigint;
  gstRateBp: number;
}

export interface TallyDocument {
  type: DocumentType;
  number: string;
  /** ISO date. */
  date: string;
  partyName: string;
  partyGstin: string;
  placeOfSupply: string;
  reference: string;
  narration: string;
  reverseCharge: boolean;
  lines: TallyLine[];
  taxablePaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  utgstPaise: bigint;
  igstPaise: bigint;
  cessPaise: bigint;
  /** Tax collected at source on the sale, which is part of the total. */
  tcsPaise: bigint;
  roundOffPaise: bigint;
  totalPaise: bigint;
}

export interface TallyPayment {
  direction: 'received' | 'made';
  date: string;
  partyName: string;
  amountPaise: bigint;
  mode: string;
  voucherNumber: string;
  reference: string;
}

export interface TallyExportInput {
  companyName: string;
  parties: TallyParty[];
  items: TallyItem[];
  documents: TallyDocument[];
  payments: TallyPayment[];
  names?: Partial<TallyNames>;
}

export interface TallyExportResult {
  xml: string;
  counts: { ledgers: number; stockItems: number; units: number; vouchers: number };
  /** Things a person should look at: a document with no party, an unknown state, an unbalanced voucher. */
  warnings: string[];
}

export const tallyDate = (iso: string): string => iso.replaceAll('-', '');
export const stateName = (code: string): string => STATES[code] ?? '';

/** A document type's Tally voucher type and which side of the books it is on. */
export function voucherKind(t: DocumentType): {
  voucherType: string;
  side: 'sales' | 'purchase';
  sign: 1 | -1;
} | null {
  switch (t) {
    case 'tax_invoice':
    case 'bill_of_supply':
      return { voucherType: 'Sales', side: 'sales', sign: 1 };
    case 'credit_note':
      return { voucherType: 'Credit Note', side: 'sales', sign: -1 };
    case 'debit_note':
      return { voucherType: 'Debit Note', side: 'sales', sign: 1 };
    case 'purchase_bill':
      return { voucherType: 'Purchase', side: 'purchase', sign: 1 };
    case 'purchase_return':
      return { voucherType: 'Debit Note', side: 'purchase', sign: -1 };
    default:
      return null;
  }
}

/** Paise to the text Tally reads: rupees and paise, signed. */
const money = (p: bigint): string => toDecimalString(p, 2);
const qtyText = (micros: bigint): string => toDecimalString(micros / 1000n, 3);

/** One ledger line of a voucher. `credit` is positive for a credit; Tally writes a debit as a negative amount. */
function ledgerEntry(name: string, credit: bigint, extra: XmlChild[] = []): string {
  const debit = credit < 0n;
  return el(
    'ALLLEDGERENTRIES.LIST',
    null,
    txt('LEDGERNAME', name),
    txt('ISDEEMEDPOSITIVE', debit ? 'Yes' : 'No'),
    txt('AMOUNT', money(credit)),
    ...extra,
  );
}

function groupFor(p: TallyParty): string {
  return p.type === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors';
}

function partyLedger(p: TallyParty): string {
  const state = stateName(p.stateCode);
  return el(
    'LEDGER',
    { NAME: p.name, ACTION: 'Create' },
    el('NAME.LIST', null, txt('NAME', p.name)),
    txt('PARENT', groupFor(p)),
    txt('ISBILLWISEON', 'Yes'),
    el('ADDRESS.LIST', null, ...p.addressLines.map((a) => txt('ADDRESS', a))),
    p.pincode && txt('PINCODE', p.pincode),
    txt('COUNTRYNAME', p.country || 'India'),
    state && txt('LEDSTATENAME', state),
    p.gstin && txt('PARTYGSTIN', p.gstin),
    txt('GSTREGISTRATIONTYPE', p.registration),
    p.pan && txt('INCOMETAXNUMBER', p.pan),
  );
}

const GST_LEDGERS: { key: keyof TallyNames; head: string; duty: string }[] = [
  { key: 'outputCgst', head: 'Output', duty: 'Central Tax' },
  { key: 'outputSgst', head: 'Output', duty: 'State Tax' },
  { key: 'outputUtgst', head: 'Output', duty: 'State Tax' },
  { key: 'outputIgst', head: 'Output', duty: 'Integrated Tax' },
  { key: 'outputCess', head: 'Output', duty: 'Cess' },
  { key: 'inputCgst', head: 'Input', duty: 'Central Tax' },
  { key: 'inputSgst', head: 'Input', duty: 'State Tax' },
  { key: 'inputUtgst', head: 'Input', duty: 'State Tax' },
  { key: 'inputIgst', head: 'Input', duty: 'Integrated Tax' },
  { key: 'inputCess', head: 'Input', duty: 'Cess' },
];

function plainLedger(name: string, parent: string, extra: XmlChild[] = []): string {
  return el(
    'LEDGER',
    { NAME: name, ACTION: 'Create' },
    el('NAME.LIST', null, txt('NAME', name)),
    txt('PARENT', parent),
    ...extra,
  );
}

function stockItem(i: TallyItem): string {
  const igst = i.gstRateBp;
  const half = igst / 2;
  const rate = (head: string, bp: number) =>
    el(
      'RATEDETAILS.LIST',
      null,
      txt('GSTRATEDUTYHEAD', head),
      txt('GSTRATEVALUATIONTYPE', 'Based on Value'),
      txt('GSTRATE', toDecimalString(BigInt(bp), 2)),
    );
  return el(
    'STOCKITEM',
    { NAME: i.name, ACTION: 'Create' },
    el('NAME.LIST', null, txt('NAME', i.name)),
    i.description && txt('DESCRIPTION', i.description),
    txt('PARENT', 'Primary'),
    txt('BASEUNITS', i.unit),
    el(
      'GSTDETAILS.LIST',
      null,
      txt('APPLICABLEFROM', '20170701'),
      txt('CALCULATIONTYPE', 'On Value'),
      i.hsn && txt('HSNCODE', i.hsn),
      txt('TAXABILITY', 'Taxable'),
      el(
        'STATEWISEDETAILS.LIST',
        null,
        txt('STATENAME', 'Any'),
        rate('Central Tax', half),
        rate('State Tax', half),
        rate('Integrated Tax', igst),
      ),
    ),
  );
}

function inventoryEntry(
  l: TallyLine,
  ledger: string,
  creditSign: 1 | -1,
  purchase: boolean,
): string {
  const amount = (purchase ? -1n : 1n) * BigInt(creditSign) * l.taxablePaise;
  const qty = `${qtyText(l.qtyMicros)} ${l.unit}`;
  return el(
    'ALLINVENTORYENTRIES.LIST',
    null,
    txt('STOCKITEMNAME', l.itemName ?? l.description),
    txt('ISDEEMEDPOSITIVE', amount < 0n ? 'Yes' : 'No'),
    txt('RATE', `${money(l.ratePaise)}/${l.unit}`),
    l.discountPaise > 0n && txt('DISCOUNT', money(l.discountPaise)),
    txt('AMOUNT', money(amount)),
    txt('ACTUALQTY', qty),
    txt('BILLEDQTY', qty),
    el(
      'ACCOUNTINGALLOCATIONS.LIST',
      null,
      txt('LEDGERNAME', ledger),
      txt('ISDEEMEDPOSITIVE', amount < 0n ? 'Yes' : 'No'),
      txt('AMOUNT', money(amount)),
    ),
  );
}

function documentVoucher(d: TallyDocument, names: TallyNames, warnings: string[]): string | null {
  const k = voucherKind(d.type);
  if (!k) return null;
  if (!d.partyName) {
    warnings.push(`${d.number}: no party, so it was left out`);
    return null;
  }
  const purchase = k.side === 'purchase';
  const q = k.sign;
  // credits from the point of view of the books: sales credit the sales ledger, purchases debit it
  const dir = (p: bigint): bigint => (purchase ? -p : p) * BigInt(q);
  const prefix = purchase ? 'input' : 'output';
  const taxName = (suffix: string) => names[`${prefix}${suffix}` as keyof TallyNames];
  const tax: [string, bigint][] = [
    [taxName('Cgst'), d.cgstPaise],
    [taxName('Sgst'), d.sgstPaise],
    [taxName('Utgst'), d.utgstPaise],
    [taxName('Igst'), d.igstPaise],
    [taxName('Cess'), d.cessPaise],
    ...(purchase ? [] : ([[names.tcs, d.tcsPaise]] as [string, bigint][])),
  ];
  const mainLedger = purchase ? names.purchases : names.sales;

  const inventory = d.lines.filter((l) => l.itemName !== null);
  const service = d.lines.filter((l) => l.itemName === null);
  const entries: string[] = [];
  // the party takes the opposite side of the sales or purchases ledger
  const total = d.totalPaise;
  entries.push(ledgerEntry(d.partyName, -dir(total), [txt('ISPARTYLEDGER', 'Yes')]));
  for (const l of service) entries.push(ledgerEntry(mainLedger, dir(l.taxablePaise)));
  for (const [name, amt] of tax) if (amt !== 0n) entries.push(ledgerEntry(name, dir(amt)));
  if (d.roundOffPaise !== 0n) entries.push(ledgerEntry(names.roundOff, dir(d.roundOffPaise)));

  // check it balances before it is written
  const sum =
    -dir(total) +
    service.reduce((a, l) => a + dir(l.taxablePaise), 0n) +
    inventory.reduce((a, l) => a + dir(l.taxablePaise), 0n) +
    tax.reduce((a, [, amt]) => a + dir(amt), 0n) +
    dir(d.roundOffPaise);
  if (sum !== 0n)
    warnings.push(`${d.number}: the lines and the total differ by ${money(sum < 0n ? -sum : sum)}`);

  return el(
    'TALLYMESSAGE',
    { 'xmlns:UDF': 'TallyUDF' },
    el(
      'VOUCHER',
      { VCHTYPE: k.voucherType, ACTION: 'Create', OBJVIEW: 'Invoice Voucher View' },
      txt('DATE', tallyDate(d.date)),
      txt('VOUCHERTYPENAME', k.voucherType),
      txt('VOUCHERNUMBER', d.number),
      txt('PARTYLEDGERNAME', d.partyName),
      d.partyGstin && txt('PARTYGSTIN', d.partyGstin),
      d.placeOfSupply && txt('PLACEOFSUPPLY', d.placeOfSupply),
      d.reference && txt('REFERENCE', d.reference),
      d.narration && txt('NARRATION', d.narration),
      txt('PERSISTEDVIEW', 'Invoice Voucher View'),
      txt('ISINVOICE', 'Yes'),
      d.reverseCharge && txt('REVERSECHARGEAPPLICABLE', 'Yes'),
      ...inventory.map((l) => inventoryEntry(l, mainLedger, q, purchase)),
      ...entries,
    ),
  );
}

function paymentVoucher(p: TallyPayment, names: TallyNames): string {
  const received = p.direction === 'received';
  const bank = /cash/i.test(p.mode) ? names.cash : names.bank;
  const type = received ? 'Receipt' : 'Payment';
  const amount = p.amountPaise;
  // a receipt credits the party and debits the bank; a payment is the other way round
  const party = received ? amount : -amount;
  return el(
    'TALLYMESSAGE',
    { 'xmlns:UDF': 'TallyUDF' },
    el(
      'VOUCHER',
      { VCHTYPE: type, ACTION: 'Create' },
      txt('DATE', tallyDate(p.date)),
      txt('VOUCHERTYPENAME', type),
      p.voucherNumber && txt('VOUCHERNUMBER', p.voucherNumber),
      txt('PARTYLEDGERNAME', p.partyName),
      p.reference && txt('NARRATION', p.reference),
      ledgerEntry(p.partyName, party, [txt('ISPARTYLEDGER', 'Yes')]),
      ledgerEntry(bank, -party),
    ),
  );
}

function envelope(report: string, company: string, messages: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    el(
      'ENVELOPE',
      null,
      el('HEADER', null, txt('TALLYREQUEST', 'Import Data')),
      el(
        'BODY',
        null,
        el(
          'IMPORTDATA',
          null,
          el(
            'REQUESTDESC',
            null,
            txt('REPORTNAME', report),
            el('STATICVARIABLES', null, txt('SVCURRENTCOMPANY', company)),
          ),
          el('REQUESTDATA', null, ...messages),
        ),
      ),
    ) +
    '\n'
  );
}

/** The masters file: units, GST ledgers, the sales and purchase ledgers, party ledgers and stock items. */
export function buildTallyMasters(input: TallyExportInput): TallyExportResult {
  const names = { ...DEFAULT_TALLY_NAMES, ...input.names };
  const warnings: string[] = [];
  const units = [...new Set(input.items.map((i) => i.unit).filter(Boolean))].sort();
  const messages: string[] = [];
  const msg = (inner: string) => el('TALLYMESSAGE', { 'xmlns:UDF': 'TallyUDF' }, inner);

  for (const u of units)
    messages.push(
      msg(
        el(
          'UNIT',
          { NAME: u, ACTION: 'Create' },
          el('NAME.LIST', null, txt('NAME', u)),
          txt('ISSIMPLEUNIT', 'Yes'),
        ),
      ),
    );
  messages.push(msg(plainLedger(names.sales, 'Sales Accounts', [txt('ISDEEMEDPOSITIVE', 'No')])));
  messages.push(
    msg(plainLedger(names.purchases, 'Purchase Accounts', [txt('ISDEEMEDPOSITIVE', 'Yes')])),
  );
  messages.push(
    msg(plainLedger(names.roundOff, 'Indirect Expenses', [txt('ISDEEMEDPOSITIVE', 'Yes')])),
  );
  messages.push(msg(plainLedger(names.tcs, 'Duties & Taxes', [txt('TAXTYPE', 'TCS')])));
  messages.push(msg(plainLedger(names.cash, 'Cash-in-Hand')));
  messages.push(msg(plainLedger(names.bank, 'Bank Accounts')));
  for (const g of GST_LEDGERS)
    messages.push(
      msg(
        plainLedger(names[g.key], 'Duties & Taxes', [
          txt('TAXTYPE', 'GST'),
          txt('GSTDUTYHEAD', g.duty),
          txt('ISDEEMEDPOSITIVE', g.head === 'Input' ? 'Yes' : 'No'),
        ]),
      ),
    );
  for (const p of input.parties) {
    if (p.stateCode && !stateName(p.stateCode))
      warnings.push(`${p.name}: unknown state code ${p.stateCode}`);
    messages.push(msg(partyLedger(p)));
  }
  for (const i of input.items) messages.push(msg(stockItem(i)));

  return {
    xml: envelope('All Masters', input.companyName, messages),
    counts: {
      ledgers: input.parties.length + 6 + GST_LEDGERS.length,
      stockItems: input.items.length,
      units: units.length,
      vouchers: 0,
    },
    warnings,
  };
}

/** The vouchers file: documents and payments. */
export function buildTallyVouchers(input: TallyExportInput): TallyExportResult {
  const names = { ...DEFAULT_TALLY_NAMES, ...input.names };
  const warnings: string[] = [];
  const messages: string[] = [];
  for (const d of input.documents) {
    const v = documentVoucher(d, names, warnings);
    if (v) messages.push(v);
  }
  for (const p of input.payments) messages.push(paymentVoucher(p, names));
  return {
    xml: envelope('Vouchers', input.companyName, messages),
    counts: { ledgers: 0, stockItems: 0, units: 0, vouchers: messages.length },
    warnings,
  };
}
