/**
 * The pre-filing checks (prompt 31): things in the documents of a period that a return would carry
 * wrongly or that a notice could later ask about. Each is a `GstrIssue`; the Filing Desk blocks export
 * until every one is fixed or acknowledged with a reason. Pure: everything it needs arrives in `ctx`.
 */
import { numberTail } from './gstr1';
import type { GstrDoc, GstrIssue, GstrPeriod } from './types';

export interface CheckContext {
  /** Today, YYYY-MM-DD (Asia/Kolkata). */
  today: string;
  /** Unregistered buyers above this invoice value need their details (0 turns the check off). */
  gstinRequiredAbovePaise: number;
  /** The rates the HSN master allows per code, in basis points. */
  hsnRates: ReadonlyMap<string, readonly number[]>;
  /** Cancelled documents that still have a payment against them. */
  cancelledWithPayments: ReadonlySet<string>;
}

export const NO_CHECK_CONTEXT: CheckContext = {
  today: '9999-12-31',
  gstinRequiredAbovePaise: 0,
  hsnRates: new Map(),
  cancelledWithPayments: new Set(),
};

const OUTWARD = new Set(['tax_invoice', 'bill_of_supply', 'credit_note', 'debit_note']);

/** The rates the master gives for a code, trying the code itself and then shorter ones (8, 6, 4 digits). */
function ratesFor(
  hsn: string,
  master: ReadonlyMap<string, readonly number[]>,
): readonly number[] | null {
  for (const n of [hsn.length, 8, 6, 4]) {
    if (n > hsn.length) continue;
    const hit = master.get(hsn.slice(0, n));
    if (hit) return hit;
  }
  return null;
}

export function prefilingChecks(
  period: GstrPeriod,
  docs: readonly GstrDoc[],
  ctx: CheckContext = NO_CHECK_CONTEXT,
): GstrIssue[] {
  const out: GstrIssue[] = [];
  const add = (
    severity: GstrIssue['severity'],
    code: string,
    table: string,
    message: string,
    docId?: string,
  ) => out.push({ severity, code, table, message, ...(docId ? { docId } : {}) });

  const rateGroups = new Map<
    string,
    { hsn: string; rateBp: number; allowed: readonly number[]; docs: GstrDoc[] }
  >();

  const mine = docs.filter(
    (d) => d.date >= period.from && d.date <= period.to && OUTWARD.has(d.type),
  );
  const issued = mine.filter((d) => d.status === 'issued');

  // the same buyer, date and amount twice under different numbers
  const groups = new Map<string, GstrDoc[]>();
  for (const d of issued) {
    if (d.type !== 'tax_invoice' && d.type !== 'bill_of_supply') continue;
    const who = d.partyGstin || d.partyName;
    if (!who) continue;
    const k = `${who}|${d.date}|${d.totalPaise}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(d);
  }
  for (const g of groups.values()) {
    if (g.length < 2 || g[0]!.totalPaise === 0) continue;
    const sorted = [...g].sort((a, b) => a.number.localeCompare(b.number));
    add(
      'warning',
      'duplicate_invoice',
      '4',
      `${sorted.map((d) => d.number).join(' and ')}: the same buyer, date and amount appear more than once`,
      sorted[1]!.id,
    );
  }

  for (const d of issued) {
    if (
      ctx.gstinRequiredAbovePaise > 0 &&
      !d.registered &&
      d.supplyType !== 'export' &&
      d.type === 'tax_invoice' &&
      d.totalPaise >= ctx.gstinRequiredAbovePaise
    ) {
      add(
        'warning',
        'b2c_above_threshold_no_gstin',
        '7',
        `${d.number}: a sale to a buyer with no GSTIN is above the INR ${ctx.gstinRequiredAbovePaise / 100} limit you set for asking for one`,
        d.id,
      );
    }
    if (d.pos && d.supplyType === 'intra' && d.pos !== d.supplierState) {
      add(
        'error',
        'supply_type_pos_mismatch',
        '4',
        `${d.number}: marked intra-state, but the place of supply (${d.pos}) is not your state (${d.supplierState})`,
        d.id,
      );
    } else if (d.pos && d.supplyType === 'inter' && d.pos === d.supplierState) {
      add(
        'error',
        'supply_type_pos_mismatch',
        '4',
        `${d.number}: marked inter-state, but the place of supply is your own state (${d.supplierState})`,
        d.id,
      );
    } else if (
      d.registered &&
      d.partyState &&
      d.pos &&
      d.pos !== d.partyState &&
      (d.supplyType === 'intra' || d.supplyType === 'inter')
    ) {
      add(
        'warning',
        'pos_differs_from_party_state',
        '4',
        `${d.number}: the place of supply (${d.pos}) is not the buyer's state (${d.partyState}); fine if it ships elsewhere`,
        d.id,
      );
    }
    if (d.type === 'credit_note' && d.linkedTotalPaise > 0 && d.totalPaise > d.linkedTotalPaise) {
      add(
        'error',
        'credit_note_exceeds_invoice',
        '9B',
        `${d.number}: the credit note is more than the invoice it refers to (${d.linkedNumber})`,
        d.id,
      );
    }
    if (d.date > ctx.today) {
      add('warning', 'date_in_future', '4', `${d.number}: dated after today`, d.id);
    }
    let badHsn = false;
    let badRate = false;
    for (const l of d.lines) {
      if (l.taxability === 'non_gst' || !l.hsn) continue;
      if (!badHsn && (!/^\d+$/.test(l.hsn) || ![2, 4, 6, 8].includes(l.hsn.length))) {
        badHsn = true;
        add(
          'error',
          'hsn_invalid_length',
          '12',
          `${d.number}: HSN ${l.hsn} should be 2, 4, 6 or 8 digits`,
          d.id,
        );
        continue;
      }
      if (
        badRate ||
        l.taxability !== 'taxable' ||
        d.supplyType === 'export' ||
        d.supplyType === 'sez'
      )
        continue;
      const rates = ratesFor(l.hsn, ctx.hsnRates);
      if (rates && !rates.includes(l.rateBp)) {
        const k = `${l.hsn}@${l.rateBp}`;
        const g = rateGroups.get(k) ?? { hsn: l.hsn, rateBp: l.rateBp, allowed: rates, docs: [] };
        if (!g.docs.includes(d)) g.docs.push(d);
        rateGroups.set(k, g);
        badRate = true;
      }
    }
  }

  // one problem per HSN and rate, not one per document: a person acknowledges the mismatch, not each bill
  for (const g of [...rateGroups.values()].sort(
    (a, b) => a.hsn.localeCompare(b.hsn) || a.rateBp - b.rateBp,
  )) {
    const numbers = g.docs.map((x) => x.number);
    const list =
      numbers.length > 3
        ? `${numbers.slice(0, 3).join(', ')} and ${numbers.length - 3} more`
        : numbers.join(', ');
    out.push({
      severity: 'warning',
      code: 'rate_not_matching_hsn',
      table: '12',
      docId: g.docs[0]!.id,
      group: `${g.hsn}@${g.rateBp}`,
      message: `HSN ${g.hsn} is taxed at ${g.rateBp / 100}% on ${list}, and the HSN list says ${g.allowed.map((r) => `${r / 100}%`).join(' or ')}`,
    });
  }

  for (const d of mine) {
    if (d.status === 'cancelled' && ctx.cancelledWithPayments.has(d.id)) {
      add(
        'error',
        'cancelled_with_payments',
        '13',
        `${d.number}: cancelled, but a payment is still recorded against it`,
        d.id,
      );
    }
  }

  // a number that is later in the series but dated earlier than the one before it
  const bySeries = new Map<string, GstrDoc[]>();
  for (const d of mine) {
    if (!d.number) continue;
    const k = `${d.type === 'tax_invoice' || d.type === 'bill_of_supply' ? 'inv' : d.type}|${d.seriesKey}`;
    (bySeries.get(k) ?? bySeries.set(k, []).get(k)!).push(d);
  }
  for (const list of bySeries.values()) {
    const sorted = [...list].sort(
      (a, b) =>
        (numberTail(a.number) ?? 0) - (numberTail(b.number) ?? 0) ||
        a.number.localeCompare(b.number),
    );
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.date < sorted[i - 1]!.date) {
        add(
          'warning',
          'date_out_of_order',
          '13',
          `${sorted[i]!.number} is dated ${sorted[i]!.date}, earlier than ${sorted[i - 1]!.number} (${sorted[i - 1]!.date}) before it in the series`,
          sorted[i]!.id,
        );
      }
    }
  }
  return out;
}

const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** A stable id for a problem in a period: the same problem always has the same key. */
export function issueKey(
  issue: Pick<GstrIssue, 'code' | 'table' | 'docId' | 'message' | 'group'>,
): string {
  // a grouped problem is the same problem whichever documents it is found on today
  if (issue.group) return `${issue.code}:${issue.group}`;
  return `${issue.code}:${issue.docId ?? issue.table}:${hash(issue.message)}`;
}
