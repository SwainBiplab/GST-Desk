/**
 * The quarterly statements (26Q for TDS, 27EQ for TCS), the data for the certificates (Form 16A and
 * 27D), and the register of tax our customers deducted from what they paid us. Pure functions over
 * plain records. The CSV headings follow the return-preparation utility's annexures as documented and
 * are NOT verified against the utility itself (see docs/compliance/direct-tax-review.md).
 */
import { toCsv, type CsvValue } from '../csv';
import { entityType } from '../gstin';
import { toDecimalString } from '../money';

import { DIRECT_TAX, tcsRule, tdsRule, type DirectTaxData } from './data';
import { depositDueDate, returnDueDate, type TaxQuarter } from './dates';
import { hasPan } from './tds';

export interface DeductionRecord {
  id: string;
  kind: 'tds' | 'tcs';
  partyId: string;
  partyName: string;
  pan: string;
  deducteeType: 'company' | 'non_company' | null;
  section: string;
  nature: string | null;
  /** Date of payment or credit (TDS) or of collection (TCS). */
  date: string;
  basePaise: bigint;
  rateBp: number;
  taxPaise: bigint;
  noPan: boolean;
  lowerCert: boolean;
  challanId: string | null;
  documentNumber: string;
}

export interface ChallanRecord {
  id: string;
  kind: 'tds' | 'tcs';
  section: string | null;
  bsr: string;
  depositDate: string;
  serial: string;
  taxPaise: bigint;
  interestPaise: bigint;
  feePaise: bigint;
}

export interface AnnexureRow {
  serial: number;
  /** `01` company, `02` anyone else. */
  partyCode: '01' | '02';
  pan: string;
  name: string;
  /** The section or nature code the utility asks for. */
  code: string;
  section: string;
  date: string;
  basePaise: bigint;
  rateBp: number;
  taxPaise: bigint;
  challan: ChallanRecord | null;
  /** Why the rate is not the ordinary one: `A` lower certificate, `C` no PAN; empty otherwise. */
  reason: string;
  documentNumber: string;
}

export interface ChallanSummary {
  challan: ChallanRecord;
  /** The tax of the deductions that name this challan. */
  mappedPaise: bigint;
  /** Deposited tax less mapped tax: negative means the challan is short. */
  differencePaise: bigint;
  /** The day the tax in it was due, the earliest of its deductions. */
  dueDate: string;
  late: boolean;
}

export interface ReturnProblem {
  severity: 'error' | 'warning';
  code: 'no_pan' | 'no_challan' | 'challan_short' | 'challan_unused' | 'late_deposit' | 'no_code';
  message: string;
  ref?: string;
}

export interface ReturnReport {
  kind: 'tds' | 'tcs';
  form: '26Q' | '27EQ';
  quarter: TaxQuarter;
  dueDate: string;
  rows: AnnexureRow[];
  totals: { basePaise: bigint; taxPaise: bigint; depositedPaise: bigint; deductions: number };
  challans: ChallanSummary[];
  problems: ReturnProblem[];
}

const codeOf = (r: DeductionRecord, data: DirectTaxData): string =>
  r.kind === 'tds'
    ? (tdsRule(r.section, data)?.code ?? '')
    : (tcsRule(r.nature ?? '', data)?.code ?? '');

function partyCode(r: DeductionRecord): '01' | '02' {
  if (r.deducteeType) return r.deducteeType === 'company' ? '01' : '02';
  return entityType(r.pan)?.letter === 'C' ? '01' : '02';
}

/** Build the statement for one quarter from the deductions and challans on record. */
export function buildReturn(
  kind: 'tds' | 'tcs',
  quarter: TaxQuarter,
  deductions: readonly DeductionRecord[],
  challans: readonly ChallanRecord[],
  data: DirectTaxData = DIRECT_TAX,
): ReturnReport {
  const byId = new Map(challans.map((c) => [c.id, c]));
  const mine = deductions
    .filter((d) => d.kind === kind && d.date >= quarter.from && d.date <= quarter.to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.partyName.localeCompare(b.partyName));
  const problems: ReturnProblem[] = [];
  const rows: AnnexureRow[] = mine.map((d, i) => {
    const code = codeOf(d, data);
    if (!code)
      problems.push({
        severity: 'error',
        code: 'no_code',
        message: `${d.partyName}: no section code is known for ${d.section}.`,
        ref: d.id,
      });
    if (!hasPan(d.pan))
      problems.push({
        severity: 'error',
        code: 'no_pan',
        message: `${d.partyName} has no valid PAN. The higher rate applies and the utility shows PANNOTAVBL.`,
        ref: d.id,
      });
    const challan = d.challanId ? (byId.get(d.challanId) ?? null) : null;
    if (!challan)
      problems.push({
        severity: 'warning',
        code: 'no_challan',
        message: `${d.partyName} (${d.date}): the tax is not matched to a challan yet.`,
        ref: d.id,
      });
    return {
      serial: i + 1,
      partyCode: partyCode(d),
      pan: hasPan(d.pan) ? d.pan.toUpperCase() : 'PANNOTAVBL',
      name: d.partyName,
      code,
      section: d.section,
      date: d.date,
      basePaise: d.basePaise,
      rateBp: d.rateBp,
      taxPaise: d.taxPaise,
      challan,
      reason: d.lowerCert ? 'A' : !hasPan(d.pan) ? 'C' : '',
      documentNumber: d.documentNumber,
    };
  });

  const used = new Set(mine.map((d) => d.challanId).filter((x): x is string => !!x));
  const summaries: ChallanSummary[] = [];
  for (const id of used) {
    const c = byId.get(id);
    if (!c) continue;
    const linked = mine.filter((d) => d.challanId === id);
    const mapped = linked.reduce((a, d) => a + d.taxPaise, 0n);
    const earliest = linked.map((d) => d.date).sort()[0] ?? c.depositDate;
    const dueDate = depositDueDate(earliest, data);
    const late = c.depositDate > dueDate;
    summaries.push({
      challan: c,
      mappedPaise: mapped,
      differencePaise: c.taxPaise - mapped,
      dueDate,
      late,
    });
    if (c.taxPaise < mapped)
      problems.push({
        severity: 'error',
        code: 'challan_short',
        message: `Challan ${c.serial} deposited less than the tax matched to it.`,
        ref: c.id,
      });
    if (late)
      problems.push({
        severity: 'warning',
        code: 'late_deposit',
        message: `Challan ${c.serial} was deposited after ${dueDate}; interest is due and the statement shows it.`,
        ref: c.id,
      });
  }
  for (const c of challans) {
    if (
      c.kind === kind &&
      !used.has(c.id) &&
      c.depositDate >= quarter.from &&
      c.depositDate <= quarter.to
    )
      problems.push({
        severity: 'warning',
        code: 'challan_unused',
        message: `Challan ${c.serial} is not matched to any deduction.`,
        ref: c.id,
      });
  }
  summaries.sort((a, b) => a.challan.depositDate.localeCompare(b.challan.depositDate));
  return {
    kind,
    form: kind === 'tds' ? '26Q' : '27EQ',
    quarter,
    dueDate: returnDueDate(quarter, data),
    rows,
    totals: {
      basePaise: rows.reduce((a, r) => a + r.basePaise, 0n),
      taxPaise: rows.reduce((a, r) => a + r.taxPaise, 0n),
      depositedPaise: summaries.reduce((a, s) => a + s.challan.taxPaise, 0n),
      deductions: rows.length,
    },
    challans: summaries,
    problems,
  };
}

const n = (p: bigint): CsvValue => ({ numeric: toDecimalString(p, 2) });
const rate = (bp: number): CsvValue => ({ numeric: toDecimalString(BigInt(bp), 2) });

/** The deductee (26Q) or collectee (27EQ) annexure as CSV. */
export function annexureCsv(r: ReturnReport): string {
  const who = r.kind === 'tds' ? 'Deductee' : 'Collectee';
  const head: CsvValue[] = [
    'Sr. No.',
    `${who} Code`,
    `PAN of ${who}`,
    `Name of ${who}`,
    r.kind === 'tds' ? 'Section Code' : 'Nature of Collection',
    r.kind === 'tds' ? 'Date of Payment/Credit' : 'Date of Collection',
    r.kind === 'tds' ? 'Amount Paid/Credited' : 'Amount Received',
    'Rate %',
    r.kind === 'tds' ? 'Tax Deducted' : 'Tax Collected',
    'Date of Deposit',
    'BSR Code',
    'Challan Serial No.',
    'Reason for Lower or Higher Rate',
    'Document',
  ];
  const lines: CsvValue[][] = [head];
  for (const x of r.rows)
    lines.push([
      String(x.serial),
      x.partyCode,
      x.pan,
      x.name,
      x.code,
      x.date,
      n(x.basePaise),
      rate(x.rateBp),
      n(x.taxPaise),
      x.challan?.depositDate ?? '',
      x.challan?.bsr ?? '',
      x.challan?.serial ?? '',
      x.reason,
      x.documentNumber,
    ]);
  lines.push([
    '',
    '',
    '',
    'Total',
    '',
    '',
    n(r.totals.basePaise),
    '',
    n(r.totals.taxPaise),
    '',
    '',
    '',
    '',
    '',
  ]);
  return toCsv(lines);
}

/** The challan summary of a statement as CSV. */
export function challanCsv(r: ReturnReport): string {
  const lines: CsvValue[][] = [
    [
      'BSR Code',
      'Date of Deposit',
      'Challan Serial No.',
      'Tax Deposited',
      'Interest',
      'Fee',
      'Tax Matched To Deductions',
      'Difference',
      'Due Date',
      'Late',
    ],
  ];
  for (const s of r.challans)
    lines.push([
      s.challan.bsr,
      s.challan.depositDate,
      s.challan.serial,
      n(s.challan.taxPaise),
      n(s.challan.interestPaise),
      n(s.challan.feePaise),
      n(s.mappedPaise),
      n(s.differencePaise),
      s.dueDate,
      s.late ? 'Y' : 'N',
    ]);
  return toCsv(lines);
}

export interface CertificateRow {
  partyId: string;
  partyName: string;
  pan: string;
  quarter: string;
  section: string;
  date: string;
  basePaise: bigint;
  taxPaise: bigint;
  bsr: string;
  depositDate: string;
  challanSerial: string;
}

/** Form 16A (TDS) or 27D (TCS) data for one party: each deduction with the challan that paid it. */
export function certificateRows(
  kind: 'tds' | 'tcs',
  quarter: TaxQuarter,
  partyId: string,
  deductions: readonly DeductionRecord[],
  challans: readonly ChallanRecord[],
): CertificateRow[] {
  const byId = new Map(challans.map((c) => [c.id, c]));
  return deductions
    .filter(
      (d) =>
        d.kind === kind && d.partyId === partyId && d.date >= quarter.from && d.date <= quarter.to,
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => {
      const c = d.challanId ? byId.get(d.challanId) : undefined;
      return {
        partyId: d.partyId,
        partyName: d.partyName,
        pan: d.pan,
        quarter: `${quarter.fy} ${quarter.quarter}`,
        section: d.section,
        date: d.date,
        basePaise: d.basePaise,
        taxPaise: d.taxPaise,
        bsr: c?.bsr ?? '',
        depositDate: c?.depositDate ?? '',
        challanSerial: c?.serial ?? '',
      };
    });
}

export function certificateCsv(kind: 'tds' | 'tcs', rows: readonly CertificateRow[]): string {
  const lines: CsvValue[][] = [
    [
      'Party',
      'PAN',
      'Quarter',
      'Section',
      kind === 'tds' ? 'Date of Payment/Credit' : 'Date of Collection',
      'Amount',
      kind === 'tds' ? 'Tax Deducted' : 'Tax Collected',
      'BSR Code',
      'Date of Deposit',
      'Challan Serial No.',
    ],
  ];
  for (const r of rows)
    lines.push([
      r.partyName,
      r.pan,
      r.quarter,
      r.section,
      r.date,
      n(r.basePaise),
      n(r.taxPaise),
      r.bsr,
      r.depositDate,
      r.challanSerial,
    ]);
  const total = rows.reduce((a, r) => a + r.taxPaise, 0n);
  lines.push(['Total', '', '', '', '', '', n(total), '', '', '']);
  return toCsv(lines);
}

export interface ReceivableRow {
  id: string;
  partyId: string;
  partyName: string;
  fy: string;
  quarter: string;
  section: string;
  date: string;
  grossPaise: bigint;
  tdsPaise: bigint;
  certificateNo: string;
  status: 'expected' | 'certificate_received' | 'claimed';
}

export interface ReceivableSummary {
  fy: string;
  expectedPaise: bigint;
  certificatePaise: bigint;
  claimedPaise: bigint;
  /** Deducted by customers but no certificate yet: the amount to chase. */
  toChasePaise: bigint;
}

/** Totals by year: what customers deducted, what is backed by a certificate, what is claimed. */
export function receivableSummary(rows: readonly ReceivableRow[]): ReceivableSummary[] {
  const by = new Map<string, ReceivableSummary>();
  for (const r of rows) {
    const s = by.get(r.fy) ?? {
      fy: r.fy,
      expectedPaise: 0n,
      certificatePaise: 0n,
      claimedPaise: 0n,
      toChasePaise: 0n,
    };
    s.expectedPaise += r.tdsPaise;
    if (r.status === 'certificate_received') s.certificatePaise += r.tdsPaise;
    if (r.status === 'claimed') {
      s.certificatePaise += r.tdsPaise;
      s.claimedPaise += r.tdsPaise;
    }
    if (r.status === 'expected') s.toChasePaise += r.tdsPaise;
    by.set(r.fy, s);
  }
  return [...by.values()].sort((a, b) => b.fy.localeCompare(a.fy));
}
