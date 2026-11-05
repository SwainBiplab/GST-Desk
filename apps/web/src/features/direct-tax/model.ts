import {
  annexureCsv,
  certificateCsv,
  certificateRows,
  challanCsv,
  type ChallanRecord,
  type DeductionRecord,
  type IncomeTaxInput,
  type ReturnReport,
} from '@gst/domain';
import { parsePaise } from '@gst/ui';

import type { IncomeForm } from './hooks';

import { toXlsx, type XlsxCell } from '@/features/reports/xlsx';

const money = (p: bigint): XlsxCell => ({ n: Number(p) / 100, fmt: 'money' });

/** The statement's annexure as an Excel sheet (text is never evaluated as a formula). */
export function annexureXlsx(r: ReturnReport): Uint8Array {
  const who = r.kind === 'tds' ? 'Deductee' : 'Collectee';
  return toXlsx({
    name: r.form,
    header: [
      'Sr. No.',
      `${who} Code`,
      `PAN of ${who}`,
      `Name of ${who}`,
      r.kind === 'tds' ? 'Section Code' : 'Nature of Collection',
      'Date',
      'Amount',
      'Rate %',
      'Tax',
      'Date of Deposit',
      'BSR Code',
      'Challan Serial No.',
      'Reason',
      'Document',
    ],
    rows: r.rows.map((x) => [
      { n: x.serial, fmt: 'int' },
      x.partyCode,
      x.pan,
      x.name,
      x.code,
      x.date,
      money(x.basePaise),
      { n: x.rateBp / 100, fmt: 'percent' },
      money(x.taxPaise),
      x.challan?.depositDate ?? '',
      x.challan?.bsr ?? '',
      x.challan?.serial ?? '',
      x.reason,
      x.documentNumber,
    ]),
    footer: [
      '',
      '',
      '',
      'Total',
      '',
      '',
      money(r.totals.basePaise),
      '',
      money(r.totals.taxPaise),
      '',
      '',
      '',
      '',
      '',
    ],
  });
}

export const fileStem = (r: ReturnReport): string =>
  `${r.form}_${r.quarter.fy}_${r.quarter.quarter}`;

export { annexureCsv, certificateCsv, certificateRows, challanCsv };

const rs = (t: string): bigint => (t.trim() === '' ? 0n : (parsePaise(t) ?? 0n));
const pct = (t: string): number => {
  const n = Number(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 100))) : 0;
};

/** Turn what was typed into the input the estimate takes. */
export function formToInput(f: IncomeForm, fy: string): IncomeTaxInput {
  const business: IncomeTaxInput['business'] =
    f.method === 'books'
      ? {
          method: 'books',
          netProfitPaise: f.netProfit.trim() === '' ? 0n : (parsePaise(f.netProfit) ?? 0n),
        }
      : f.method === '44AD'
        ? { method: '44AD', turnoverPaise: rs(f.turnover), digitalShareBp: pct(f.digitalPct) }
        : { method: '44ADA', receiptsPaise: rs(f.receipts), cashShareBp: pct(f.cashPct) };
  return {
    fy,
    age: f.age,
    business,
    otherIncomePaise: rs(f.other),
    deductions: {
      section80C: rs(f.d80c),
      section80CCD1B: rs(f.d80ccd),
      section80DSelf: rs(f.d80dSelf),
      section80DParents: rs(f.d80dParents),
      parentsSenior: f.parentsSenior,
      homeLoanInterest: rs(f.homeLoan),
      other: rs(f.dOther),
    },
    creditPaise: rs(f.credit),
    advance: f.advance
      .filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a.date) && rs(a.amount) > 0n)
      .map((a) => ({ date: a.date, paise: rs(a.amount) })),
    ...(/^\d{4}-\d{2}-\d{2}$/.test(f.filing) ? { filingDate: f.filing } : {}),
  };
}

export type { ChallanRecord, DeductionRecord };
