/**
 * Tally XML in: masters (groups, ledgers, stock items) and vouchers read into the neutral shapes in
 * `types.ts`. The file is read as a stream, so a very large export is never held whole; only the small
 * summary of each voucher is kept until the end, when ledgers and vouchers can be matched whatever order
 * they came in.
 *
 * Tally writes a credit as a positive amount and a debit as a negative one. Everything below keeps
 * that, "credit positive", until a document is built.
 *
 * STATUS: written from the public documentation of Tally's XML export. It has NOT been run against a
 * real export. See docs/compliance/tally-interop.md.
 */
import { STATES, parseAmountPaise, parseQtyMicros, type DocumentType } from '@gst/domain';

import {
  emptyBundle,
  type ImportBundle,
  type ImportDocument,
  type ImportItem,
  type ImportLine,
  type ImportParty,
} from './types';
import { XmlStream, child, kids, textOf, type XmlNode } from './xml';

const WANTED = new Set(['LEDGER', 'GROUP', 'STOCKITEM', 'VOUCHER']);

interface LedgerMaster {
  name: string;
  parent: string;
  gstin: string;
  pan: string;
  stateName: string;
  address: string[];
  pincode: string;
  /** Credit positive, as Tally writes it. */
  openingCredit: bigint;
  dutyHead: string;
}

interface RawEntry {
  name: string;
  /** Credit positive. */
  amount: bigint;
}
interface RawInventory {
  item: string;
  qty: string;
  rate: string;
  amount: bigint;
  discount: string;
  hsn: string;
  ledger: string;
}
interface RawVoucher {
  vchType: string;
  number: string;
  date: string;
  party: string;
  gstin: string;
  pos: string;
  reference: string;
  narration: string;
  cancelled: boolean;
  optional: boolean;
  reverseCharge: boolean;
  entries: RawEntry[];
  inventory: RawInventory[];
}

const yes = (s: string): boolean => s.trim().toLowerCase() === 'yes';

/** A Tally amount ("-1,180.00", "1180", "₹ 5.5") to paise, credit positive. Null when it is not a number. */
export function tallyPaise(text: string): bigint | null {
  const t = text.replace(/[,\s₹]/g, '').replace(/^Rs\.?/i, '');
  if (t === '') return null;
  const v = parseAmountPaise(t, { allowNegative: true });
  return typeof v === 'number' ? BigInt(v) : null;
}

/** "10 Nos" to micro-units and a unit. A compound unit ("1 Box = 12 Nos") keeps the part before `=`. */
export function tallyQuantity(text: string): { qtyMicros: bigint; unit: string } | null {
  const m = /^\s*(-?[\d,]*\.?\d+)\s*([^=]*)/.exec(text.replace(/\s=.*/, ''));
  if (!m) return null;
  const q = parseQtyMicros(m[1]!.replace(/,/g, ''), { allowNegative: true });
  if (typeof q !== 'number') return null;
  return { qtyMicros: BigInt(q), unit: m[2]!.trim() };
}

/** "100.00/Nos" to paise per unit and the unit. */
export function tallyRate(text: string): { ratePaise: bigint; unit: string } | null {
  const [num, unit = ''] = text.split('/');
  const p = tallyPaise(num ?? '');
  return p === null ? null : { ratePaise: p, unit: unit.trim() };
}

/** `20250412` (or an ISO date) to an ISO date; empty when it is neither. */
export function tallyIsoDate(text: string): string {
  const t = text.trim();
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

const STATE_BY_NAME = new Map(
  Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]),
);
const stateCodeOf = (name: string): string => STATE_BY_NAME.get(name.trim().toLowerCase()) ?? '';

const STANDARD_RATES_BP = [0, 25, 50, 100, 150, 300, 500, 1200, 1800, 2800, 4000];

/** The tax rate a line was most likely taxed at: the nearest standard rate when it is close, else as worked out. */
export function snapRate(rawBp: number): number {
  let best = rawBp;
  let gap = 21;
  for (const r of STANDARD_RATES_BP) {
    const d = Math.abs(r - rawBp);
    if (d < gap) {
      gap = d;
      best = r;
    }
  }
  return best;
}

const HEAD = /(cgst|sgst|utgst|igst|cess)/i;

export class TallyReader {
  private readonly stream: XmlStream;
  private readonly groups = new Map<string, string>();
  private readonly ledgers = new Map<string, LedgerMaster>();
  private readonly items: ImportItem[] = [];
  private readonly vouchers: RawVoucher[] = [];

  constructor() {
    this.stream = new XmlStream(WANTED, (n) => this.element(n));
  }

  /** Feed the next piece of the file as text. */
  feed(chunk: string): void {
    this.stream.write(chunk);
  }

  private element(n: XmlNode): void {
    if (n.name === 'GROUP') {
      const name = n.attrs['NAME'] || textOf(n, 'NAME');
      if (name) this.groups.set(name, textOf(n, 'PARENT'));
    } else if (n.name === 'LEDGER') this.ledger(n);
    else if (n.name === 'STOCKITEM') this.stockItem(n);
    else if (n.name === 'VOUCHER') this.voucher(n);
  }

  private ledger(n: XmlNode): void {
    const name = n.attrs['NAME'] || textOf(n, 'NAME') || textOf(child(n, 'NAME.LIST') ?? n, 'NAME');
    if (!name) return;
    const reg = child(n, 'LEDGSTREGDETAILS.LIST');
    const mail = child(n, 'LEDMAILINGDETAILS.LIST');
    const opening = tallyPaise(textOf(n, 'OPENINGBALANCE')) ?? 0n;
    this.ledgers.set(name, {
      name,
      parent: textOf(n, 'PARENT'),
      gstin: (
        textOf(n, 'PARTYGSTIN') ||
        (reg ? textOf(reg, 'GSTIN') : '') ||
        textOf(n, 'GSTIN')
      ).toUpperCase(),
      pan: (textOf(n, 'INCOMETAXNUMBER') || textOf(n, 'PANIT')).toUpperCase(),
      stateName:
        textOf(n, 'LEDSTATENAME') ||
        (mail ? textOf(mail, 'STATE') : '') ||
        (reg ? textOf(reg, 'STATE') : ''),
      address: [
        ...kids(child(n, 'ADDRESS.LIST') ?? n, 'ADDRESS').map((a) => a.text),
        ...(mail ? kids(child(mail, 'ADDRESS.LIST') ?? mail, 'ADDRESS').map((a) => a.text) : []),
      ].filter(Boolean),
      pincode: textOf(n, 'PINCODE') || (mail ? textOf(mail, 'PINCODE') : ''),
      openingCredit: opening,
      dutyHead: textOf(n, 'GSTDUTYHEAD'),
    });
  }

  private stockItem(n: XmlNode): void {
    const name = n.attrs['NAME'] || textOf(n, 'NAME') || textOf(child(n, 'NAME.LIST') ?? n, 'NAME');
    if (!name) return;
    const details = kids(n, 'GSTDETAILS.LIST');
    // the latest applicable entry wins
    const last = [...details]
      .sort((a, b) => textOf(a, 'APPLICABLEFROM').localeCompare(textOf(b, 'APPLICABLEFROM')))
      .pop();
    let rateBp: number | null = null;
    let hsn = '';
    if (last) {
      hsn = textOf(last, 'HSNCODE');
      const rates = kids(last, 'STATEWISEDETAILS.LIST').flatMap((s) => kids(s, 'RATEDETAILS.LIST'));
      const rate = (head: string) => {
        const r = rates.find((x) => textOf(x, 'GSTRATEDUTYHEAD') === head);
        return r ? Math.round(Number(textOf(r, 'GSTRATE')) * 100) : null;
      };
      const igst = rate('Integrated Tax');
      const cgst = rate('Central Tax');
      rateBp = igst ?? (cgst === null ? null : cgst * 2);
      if (rateBp !== null && !Number.isFinite(rateBp)) rateBp = null;
    }
    this.items.push({
      name,
      sku: '',
      hsn,
      unit: textOf(n, 'BASEUNITS'),
      gstRateBp: rateBp,
      sellPaise: 0n,
      buyPaise: 0n,
      kind: 'goods',
    });
  }

  private voucher(n: XmlNode): void {
    const entryNodes = [...kids(n, 'ALLLEDGERENTRIES.LIST'), ...kids(n, 'LEDGERENTRIES.LIST')];
    const invNodes = [...kids(n, 'ALLINVENTORYENTRIES.LIST'), ...kids(n, 'INVENTORYENTRIES.LIST')];
    this.vouchers.push({
      vchType: n.attrs['VCHTYPE'] || textOf(n, 'VOUCHERTYPENAME'),
      number: textOf(n, 'VOUCHERNUMBER'),
      date: tallyIsoDate(textOf(n, 'DATE')),
      party: textOf(n, 'PARTYLEDGERNAME'),
      gstin: textOf(n, 'PARTYGSTIN').toUpperCase(),
      pos: textOf(n, 'PLACEOFSUPPLY'),
      reference: textOf(n, 'REFERENCE'),
      narration: textOf(n, 'NARRATION'),
      cancelled: yes(textOf(n, 'ISCANCELLED')),
      optional: yes(textOf(n, 'ISOPTIONAL')),
      reverseCharge: yes(textOf(n, 'REVERSECHARGEAPPLICABLE')),
      entries: entryNodes.map((e) => ({
        name: textOf(e, 'LEDGERNAME'),
        amount: tallyPaise(textOf(e, 'AMOUNT')) ?? 0n,
      })),
      inventory: invNodes.map((e) => ({
        item: textOf(e, 'STOCKITEMNAME'),
        qty: textOf(e, 'BILLEDQTY') || textOf(e, 'ACTUALQTY'),
        rate: textOf(e, 'RATE'),
        amount: tallyPaise(textOf(e, 'AMOUNT')) ?? 0n,
        discount: textOf(e, 'DISCOUNT'),
        hsn: textOf(e, 'HSNCODE') || textOf(child(e, 'GSTDETAILS.LIST') ?? e, 'HSNCODE'),
        ledger: textOf(child(e, 'ACCOUNTINGALLOCATIONS.LIST') ?? e, 'LEDGERNAME'),
      })),
    });
  }

  /** The top group of a ledger's parent chain (`Sundry Debtors`, `Sales Accounts`, ...), or its own parent. */
  private root(name: string): string {
    let g = this.ledgers.get(name)?.parent ?? '';
    for (let i = 0; i < 20; i++) {
      const up = this.groups.get(g);
      if (!up || up === 'Primary' || up === g) break;
      g = up;
    }
    return g;
  }

  /** No more text is coming: match everything up and return what was found. */
  finish(): ImportBundle {
    this.stream.end();
    const out = emptyBundle('tally');
    const issue = (severity: 'error' | 'warning' | 'info', ref: string, message: string) =>
      out.issues.push({ severity, ref, message });

    out.items.push(...this.items);
    const itemRate = new Map(this.items.map((i) => [i.name, i]));

    const known = new Map<string, ImportParty>();
    for (const l of this.ledgers.values()) {
      const root = this.root(l.name);
      const debtor = /sundry debtors/i.test(root) || /sundry debtors/i.test(l.parent);
      const creditor = /sundry creditors/i.test(root) || /sundry creditors/i.test(l.parent);
      if (!debtor && !creditor) continue;
      const p: ImportParty = {
        name: l.name,
        type: debtor ? 'customer' : 'supplier',
        gstin: l.gstin,
        pan: l.pan || (l.gstin.length === 15 ? l.gstin.slice(2, 12) : ''),
        stateCode: stateCodeOf(l.stateName) || (l.gstin.length === 15 ? l.gstin.slice(0, 2) : ''),
        phone: '',
        email: '',
        addressLine: l.address.join(', '),
        city: '',
        pincode: l.pincode,
        // Tally writes a debit (they owe us) as a negative number
        openingBalancePaise: -l.openingCredit,
        country: 'India',
      };
      known.set(l.name, p);
    }

    for (const v of this.vouchers) {
      const ref = `${v.vchType} ${v.number}`.trim();
      const type = v.vchType.toLowerCase();
      if (v.cancelled || v.optional) {
        issue(
          'warning',
          ref,
          v.cancelled ? 'cancelled voucher, not imported' : 'optional voucher, not imported',
        );
        continue;
      }
      if (type === 'receipt' || type === 'payment') {
        this.payment(v, ref, out, issue);
        continue;
      }
      if (!['sales', 'purchase', 'credit note', 'debit note'].includes(type)) {
        issue('info', ref, `${v.vchType || 'unnamed'} vouchers are not imported`);
        continue;
      }
      const doc = this.document(v, ref, itemRate, issue);
      if (!doc) continue;
      out.documents.push(doc);
      if (doc.partyName && !known.has(doc.partyName)) {
        known.set(doc.partyName, {
          name: doc.partyName,
          type:
            doc.type === 'purchase_bill' || doc.type === 'purchase_return'
              ? 'supplier'
              : 'customer',
          gstin: doc.partyGstin,
          pan: doc.partyGstin.length === 15 ? doc.partyGstin.slice(2, 12) : '',
          stateCode: doc.partyGstin.length === 15 ? doc.partyGstin.slice(0, 2) : doc.placeOfSupply,
          phone: '',
          email: '',
          addressLine: '',
          city: '',
          pincode: '',
          openingBalancePaise: 0n,
          country: 'India',
        });
        issue('info', ref, `no ledger master for ${doc.partyName}; it is created from the voucher`);
      }
    }
    out.parties.push(...known.values());
    return out;
  }

  private payment(
    v: RawVoucher,
    ref: string,
    out: ImportBundle,
    issue: (s: 'error' | 'warning' | 'info', r: string, m: string) => void,
  ): void {
    const received = v.vchType.toLowerCase() === 'receipt';
    const partyEntry =
      v.entries.find((e) => e.name === v.party) ??
      v.entries.find((e) => (received ? e.amount > 0n : e.amount < 0n));
    if (!partyEntry || !v.date) {
      issue('error', ref, 'no party line or no date, not imported');
      return;
    }
    const account = v.entries.find((e) => e !== partyEntry)?.name ?? '';
    out.payments.push({
      source: 'tally',
      ref,
      direction: received ? 'received' : 'made',
      date: v.date,
      partyName: partyEntry.name,
      amountPaise: partyEntry.amount < 0n ? -partyEntry.amount : partyEntry.amount,
      account,
      reference: v.number || v.narration,
    });
  }

  private document(
    v: RawVoucher,
    ref: string,
    itemMaster: Map<string, ImportItem>,
    issue: (s: 'error' | 'warning' | 'info', r: string, m: string) => void,
  ): ImportDocument | null {
    if (!v.date) {
      issue('error', ref, 'no date, not imported');
      return null;
    }
    if (!v.number) {
      issue('error', ref, 'no voucher number, not imported');
      return null;
    }
    const partyEntry =
      v.entries.find((e) => e.name === v.party) ??
      v.entries.find((e) => /sundry (debtors|creditors)/i.test(this.root(e.name)));
    const partyName = v.party || partyEntry?.name || '';
    if (!partyEntry) {
      issue('error', ref, 'no party line, not imported');
      return null;
    }
    const abs = (x: bigint) => (x < 0n ? -x : x);
    const others = v.entries.filter((e) => e !== partyEntry);
    const atSource = (name: string) => /\b(tcs|tds)\b/i.test(name);
    const taxEntries = others.filter(
      (e) =>
        !atSource(e.name) &&
        (HEAD.test(e.name) ||
          /duties/i.test(this.root(e.name)) ||
          this.ledgers.get(e.name)?.dutyHead),
    );
    const roundEntries = others.filter((e) => !taxEntries.includes(e) && /round/i.test(e.name));
    const collected = others.filter(
      (e) => !taxEntries.includes(e) && !roundEntries.includes(e) && atSource(e.name),
    );
    if (collected.length > 0)
      issue(
        'warning',
        ref,
        'tax collected or deducted at source on the voucher is not imported; the totals will differ',
      );
    const revenue = others.filter(
      (e) => !taxEntries.includes(e) && !roundEntries.includes(e) && !collected.includes(e),
    );
    const taxTotal = taxEntries.reduce((a, e) => a + abs(e.amount), 0n);
    const cessTotal = taxEntries
      .filter((e) => /cess/i.test(e.name))
      .reduce((a, e) => a + abs(e.amount), 0n);
    const gstTotal = taxTotal - cessTotal;

    const t = v.vchType.toLowerCase();
    const purchaseSide =
      v.inventory.length > 0
        ? /purchase/i.test(v.inventory[0]!.ledger) ||
          /purchase/i.test(this.root(v.inventory[0]!.ledger))
        : revenue.some((e) => /purchase/i.test(e.name) || /purchase/i.test(this.root(e.name)));
    let docType: DocumentType;
    if (t === 'sales') docType = 'tax_invoice';
    else if (t === 'purchase') docType = 'purchase_bill';
    else if (t === 'credit note') docType = purchaseSide ? 'purchase_bill' : 'credit_note';
    else docType = purchaseSide ? 'purchase_return' : 'debit_note';
    if (t === 'credit note' && purchaseSide)
      issue(
        'warning',
        ref,
        'a credit note on the purchase side is not imported as a return; check it by hand',
      );

    const lines: ImportLine[] = [];
    if (v.inventory.length > 0) {
      for (const inv of v.inventory) {
        const q = tallyQuantity(inv.qty);
        const r = tallyRate(inv.rate);
        const taxable = abs(inv.amount);
        const qtyMicros = q?.qtyMicros ?? 1_000_000n;
        const ratePaise =
          r?.ratePaise ?? (qtyMicros > 0n ? (taxable * 1_000_000n) / qtyMicros : taxable);
        const gross = (qtyMicros * ratePaise) / 1_000_000n;
        const master = itemMaster.get(inv.item);
        lines.push({
          description: inv.item,
          itemName: inv.item,
          hsn: inv.hsn || master?.hsn || '',
          qtyMicros,
          unit: q?.unit || r?.unit || master?.unit || '',
          ratePaise,
          discountPaise: gross > taxable ? gross - taxable : 0n,
          taxablePaise: taxable,
          gstRateBp: master?.gstRateBp ?? null,
          cessBp: 0,
        });
      }
    } else {
      for (const e of revenue)
        lines.push({
          description: e.name,
          itemName: null,
          hsn: '',
          qtyMicros: 1_000_000n,
          unit: '',
          ratePaise: abs(e.amount),
          discountPaise: 0n,
          taxablePaise: abs(e.amount),
          gstRateBp: null,
          cessBp: 0,
        });
    }
    if (lines.length === 0) {
      issue('error', ref, 'no lines and no sales or purchase ledger, not imported');
      return null;
    }

    // lines the master gives no rate for are taxed at the voucher's effective rate
    const taxableSum = lines.reduce((a, l) => a + l.taxablePaise, 0n);
    const effective =
      taxableSum > 0n ? snapRate(Number((gstTotal * 10_000n + taxableSum / 2n) / taxableSum)) : 0;
    const cessBp =
      taxableSum > 0n ? Number((cessTotal * 10_000n + taxableSum / 2n) / taxableSum) : 0;
    let guessed = false;
    for (const l of lines) {
      if (l.gstRateBp === null) {
        l.gstRateBp = effective;
        guessed = true;
      }
      l.cessBp = cessBp;
    }
    if (guessed && lines.length > 1 && taxTotal > 0n)
      issue(
        'warning',
        ref,
        `the rate of each line is taken as ${effective / 100}% from the tax on the voucher`,
      );

    return {
      source: 'tally',
      ref,
      type: docType,
      number: v.number,
      date: v.date,
      partyName,
      partyGstin: v.gstin,
      placeOfSupply: stateCodeOf(v.pos),
      reverseCharge: v.reverseCharge,
      lines,
      fileTotalPaise: abs(partyEntry.amount),
      fileTaxPaise: taxTotal,
      narration: v.narration,
    };
  }
}

/** Read a whole Tally export held as text. */
export function readTally(text: string): ImportBundle {
  const r = new TallyReader();
  r.feed(text);
  return r.finish();
}

/** Read a Tally export that arrives in pieces (a file stream). */
export async function readTallyAsync(source: AsyncIterable<string>): Promise<ImportBundle> {
  const r = new TallyReader();
  for await (const chunk of source) r.feed(chunk);
  return r.finish();
}
