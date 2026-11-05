/** Return periods, the filing calendar and the status a card shows. */
import { DUE_DATE_RULES_V1, type DueDateRules } from '../../data/gstn-schemas/due-dates';

import type { GstrPeriod } from './types';

const pad = (n: number): string => String(n).padStart(2, '0');

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthPeriod(gstin: string, year: number, month: number): GstrPeriod {
  return {
    gstin,
    fp: `${pad(month)}${year}`,
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(lastDay(year, month))}`,
    kind: 'month',
  };
}

/** The quarter that ends in `endMonth` (3, 6, 9 or 12). */
export function quarterPeriod(gstin: string, year: number, endMonth: number): GstrPeriod {
  const startMonth = endMonth - 2;
  return {
    gstin,
    fp: `${pad(endMonth)}${year}`,
    from: `${year}-${pad(startMonth)}-01`,
    to: `${year}-${pad(endMonth)}-${pad(lastDay(year, endMonth))}`,
    kind: 'quarter',
  };
}

/** The month or quarter that contains `date` (YYYY-MM-DD). */
export function periodOf(
  gstin: string,
  date: string,
  kind: 'month' | 'quarter' = 'month',
): GstrPeriod {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (kind === 'month') return monthPeriod(gstin, year, month);
  return quarterPeriod(gstin, year, Math.ceil(month / 3) * 3);
}

/** Periods from `fromDate` through the one that holds `toDate`, oldest first. */
export function periodsBetween(
  gstin: string,
  fromDate: string,
  toDate: string,
  kind: 'month' | 'quarter' = 'month',
): GstrPeriod[] {
  const out: GstrPeriod[] = [];
  let p = periodOf(gstin, fromDate, kind);
  const last = periodOf(gstin, toDate, kind);
  for (let guard = 0; guard < 600; guard++) {
    out.push(p);
    if (p.to >= last.to) break;
    p = periodOf(gstin, addDaysIso(p.to, 1), kind);
  }
  return out;
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type Return = 'gstr1' | 'gstr3b';

/** Due date (YYYY-MM-DD) of a return for a period, from the rules, unless the business set its own. */
export function dueDate(
  ret: Return,
  period: GstrPeriod,
  stateCode: string,
  overrides: Record<string, string> = {},
  rules: DueDateRules = DUE_DATE_RULES_V1,
): { date: string; overridden: boolean } {
  const key = `${ret}:${period.fp}`;
  const own = overrides[key];
  if (own) return { date: own, overridden: true };
  const next = addDaysIso(period.to, 1); // first day of the next month
  const ym = next.slice(0, 7);
  let day: number;
  if (period.kind === 'month') {
    day = ret === 'gstr1' ? rules.monthly.gstr1Day : rules.monthly.gstr3bDay;
  } else if (ret === 'gstr1') {
    day = rules.quarterly.gstr1Day;
  } else {
    day = rules.groupXStates.includes(stateCode)
      ? rules.quarterly.gstr3bDayGroupX
      : rules.quarterly.gstr3bDayGroupY;
  }
  return { date: `${ym}-${pad(day)}`, overridden: false };
}

export type FilingStatus = 'not_started' | 'ready' | 'exported' | 'filed' | 'late';

/**
 * What a card shows. `filed` and `exported` come from what the person recorded; `ready` means the
 * period has documents and no blocking error; `late` means the due date passed and it is not filed.
 */
export function filingStatus(input: {
  filed: boolean;
  exported: boolean;
  hasDocuments: boolean;
  blockers: number;
  today: string;
  due: string;
}): FilingStatus {
  if (input.filed) return 'filed';
  if (input.today > input.due) return 'late';
  if (input.exported) return 'exported';
  if (input.hasDocuments && input.blockers === 0) return 'ready';
  return 'not_started';
}

/** DD-MM-YYYY for the GSTN files. */
export function gstnDate(date: string): string {
  return `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
}
