/**
 * TDS and TCS (prompt 33): reads what we paid and sold into the shapes the calculation in `@gst/domain`
 * takes, keeps the record of what was actually deducted or collected, the challans that paid it, and the
 * tax our customers deducted from what they paid us. The arithmetic is in the domain package.
 */
import {
  computeTcs,
  computeTds,
  fyOfDate,
  fyStartYear,
  quarterOf,
  type ChallanRecord,
  type Deduction,
  type DeductionRecord,
  type LowerCert,
  type ReceivableRow,
} from '@gst/domain';
import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { BaseRepo, RuleError, runInTx, type Ctx } from './base';

const n = (v: unknown): number => Number(v ?? 0);
const b = (v: unknown): bigint => BigInt(Math.trunc(Number(v ?? 0)));
const s = (v: unknown): string => (v == null ? '' : String(v));
const flag = (v: unknown): boolean => v === true || Number(v) === 1;

class DeductionRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'tax_deductions');
  }
}
class ChallanRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'tax_challans');
  }
}
class ReceivableRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'tds_receivable');
  }
}

/** What the software suggests we deduct or collect on one document. */
export interface Proposal {
  kind: 'tds' | 'tcs';
  partyId: string;
  partyName: string;
  documentId: string;
  documentNumber: string;
  date: string;
  section: string;
  nature: string | null;
  basePaise: bigint;
  rateBp: number;
  taxPaise: bigint;
  noPan: boolean;
  lowerCert: boolean;
  why: string;
}

export interface ManualInput {
  kind: 'tds' | 'tcs';
  partyId: string;
  /** The section (TDS) or the nature (TCS). */
  rule: string;
  date: string;
  basePaise: bigint;
  documentId?: string | null;
  note?: string;
}

export interface NewChallan {
  kind: 'tds' | 'tcs';
  fy: string;
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  section?: string | null;
  bsr: string;
  depositDate: string;
  serial: string;
  taxPaise: bigint;
  interestPaise?: bigint;
  feePaise?: bigint;
  note?: string;
}

const PURCHASE_TYPES = ['purchase_bill', 'expense'];
const SALE_TYPES = ['tax_invoice', 'bill_of_supply'];

function lowerOf(p: Row): LowerCert | null {
  if (p['lower_cert_rate_bp'] == null || !p['lower_cert_from'] || !p['lower_cert_to']) return null;
  return {
    rateBp: n(p['lower_cert_rate_bp']),
    validFrom: s(p['lower_cert_from']),
    validTo: s(p['lower_cert_to']),
    ...(p['lower_cert_limit_paise'] == null ? {} : { limitPaise: b(p['lower_cert_limit_paise']) }),
  };
}

export class DirectTaxRepo {
  private readonly deductionRows: DeductionRows;
  private readonly challanRows: ChallanRows;
  private readonly receivableRows: ReceivableRows;
  constructor(private readonly d: Database) {
    this.deductionRows = new DeductionRows(d);
    this.challanRows = new ChallanRows(d);
    this.receivableRows = new ReceivableRows(d);
  }

  /** Every deduction or collection in a year, with the party and document it came from. */
  async deductions(ctx: Ctx, fy: string): Promise<DeductionRecord[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT t.id, t.kind, t.party_id, t.section, t.nature, t.date, t.base_paise, t.rate_bp,
                   t.tax_paise, t.no_pan, t.lower_cert, t.challan_id,
                   p.name AS party_name, coalesce(p.pan, '') AS pan, p.deductee_type,
                   coalesce(d.number, '') AS doc_number
            FROM tax_deductions t
            JOIN parties p ON p.id = t.party_id
            LEFT JOIN documents d ON d.id = t.document_id
            WHERE t.business_id = ${ctx.businessId} AND t.deleted_at IS NULL AND t.fy = ${fy}
            ORDER BY t.date, p.name, t.id`,
      );
      return rows.map((r) => ({
        id: s(r['id']),
        kind: s(r['kind']) as 'tds' | 'tcs',
        partyId: s(r['party_id']),
        partyName: s(r['party_name']),
        pan: s(r['pan']),
        deducteeType:
          r['deductee_type'] == null ? null : (s(r['deductee_type']) as 'company' | 'non_company'),
        section: s(r['section']),
        nature: r['nature'] == null ? null : s(r['nature']),
        date: s(r['date']),
        basePaise: b(r['base_paise']),
        rateBp: n(r['rate_bp']),
        taxPaise: b(r['tax_paise']),
        noPan: flag(r['no_pan']),
        lowerCert: flag(r['lower_cert']),
        challanId: r['challan_id'] == null ? null : s(r['challan_id']),
        documentNumber: s(r['doc_number']),
      }));
    });
  }

  async challans(ctx: Ctx, fy: string): Promise<ChallanRecord[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await this.challanRows.list({ ...ctx, tx });
      return rows
        .filter((r) => r['fy'] === fy)
        .map((r) => ({
          id: s(r['id']),
          kind: s(r['kind']) as 'tds' | 'tcs',
          section: r['section'] == null ? null : s(r['section']),
          bsr: s(r['bsr_code']),
          depositDate: s(r['deposit_date']),
          serial: s(r['serial']),
          taxPaise: b(r['tax_paise']),
          interestPaise: b(r['interest_paise']),
          feePaise: b(r['fee_paise']),
        }))
        .sort((x, y) => x.depositDate.localeCompare(y.depositDate));
    });
  }

  /** Turnover of a year: issued sales less credit notes, before GST. */
  async turnover(ctx: Ctx, from: string, to: string): Promise<bigint> {
    return runInTx(this.d, ctx, async (tx) => {
      const r = await queryRows(
        this.d,
        tx,
        sql`SELECT coalesce(sum(CASE WHEN type = 'credit_note' THEN -total_taxable_paise ELSE total_taxable_paise END), 0) AS v
            FROM documents
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND status = 'issued'
              AND type IN ('tax_invoice', 'bill_of_supply', 'debit_note', 'credit_note')
              AND date >= ${from} AND date <= ${to}`,
      );
      return b(r[0]?.['v']);
    });
  }

  /** Net profit from the ledger: income less expense over the period. */
  async profitFromBooks(ctx: Ctx, from: string, to: string): Promise<bigint> {
    return runInTx(this.d, ctx, async (tx) => {
      const r = await queryRows(
        this.d,
        tx,
        sql`SELECT coalesce(sum(CASE WHEN a.type = 'income' THEN e.credit_paise - e.debit_paise
                                     WHEN a.type = 'expense' THEN e.credit_paise - e.debit_paise
                                     ELSE 0 END), 0) AS v
            FROM ledger_entries e
            JOIN ledger_accounts a ON a.id = e.account_id
            WHERE e.business_id = ${ctx.businessId} AND e.deleted_at IS NULL
              AND e.date >= ${from} AND e.date <= ${to}`,
      );
      return b(r[0]?.['v']);
    });
  }

  /**
   * What is suggested for the year: for each issued purchase bill or expense of a party that has a TDS
   * section (or each sale to a party with a TCS nature) that has no deduction yet, what the rules say.
   * Documents are taken in date order so a threshold crossed part-way through the year lands on the
   * right payment, and earlier payments are caught up on it.
   */
  async proposals(ctx: Ctx, fy: string, kind: 'tds' | 'tcs'): Promise<Proposal[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const start = fyStartYear(fy);
      const from = `${start}-04-01`;
      const to = `${start + 1}-03-31`;
      const types = kind === 'tds' ? PURCHASE_TYPES : SALE_TYPES;
      const typeList = sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      );
      const ruleCol = kind === 'tds' ? sql`p.tds_section` : sql`p.tcs_nature`;
      const docs = await queryRows(
        this.d,
        tx,
        sql`SELECT d.id, d.number, d.date, d.total_paise, d.total_taxable_paise,
                   p.id AS party_id, p.name AS party_name, coalesce(p.pan, '') AS pan,
                   ${ruleCol} AS rule, p.tds_category, p.tds_kind,
                   p.lower_cert_rate_bp, p.lower_cert_from, p.lower_cert_to, p.lower_cert_limit_paise
            FROM documents d
            JOIN parties p ON p.id = d.party_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND d.status = 'issued'
              AND d.type IN (${typeList}) AND d.date >= ${from} AND d.date <= ${to}
              AND ${ruleCol} IS NOT NULL AND ${ruleCol} <> ''
            ORDER BY d.date, d.number, d.id`,
      );
      const done = await queryRows(
        this.d,
        tx,
        sql`SELECT document_id, party_id, section, base_paise, lower_cert
            FROM tax_deductions
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND kind = ${kind} AND fy = ${fy}`,
      );
      const recorded = new Map(
        done.filter((r) => r['document_id']).map((r) => [s(r['document_id']), r]),
      );
      const prior = start - 1;
      const priorTurnover =
        kind === 'tds'
          ? await this.turnover({ ...ctx, tx }, `${prior}-04-01`, `${start}-03-31`)
          : 0n;

      const cumulative = new Map<string, bigint>();
      const taxed = new Map<string, bigint>();
      const lowerUsed = new Map<string, bigint>();
      const out: Proposal[] = [];
      for (const r of docs) {
        const rule = s(r['rule']);
        const key = `${s(r['party_id'])}|${rule}`;
        const excl =
          n(r['total_taxable_paise']) > 0 ? b(r['total_taxable_paise']) : b(r['total_paise']);
        const base = kind === 'tcs' && rule === 'sale_of_goods' ? b(r['total_paise']) : excl;
        const date = s(r['date']);
        const rec = recorded.get(s(r['id']));
        const before = cumulative.get(key) ?? 0n;
        cumulative.set(key, before + base);
        if (rec) {
          taxed.set(key, (taxed.get(key) ?? 0n) + b(rec['base_paise']));
          if (flag(rec['lower_cert']))
            lowerUsed.set(key, (lowerUsed.get(key) ?? 0n) + b(rec['base_paise']));
          continue;
        }
        if (kind === 'tcs' && rule === 'sale_of_goods') continue; // from receipts, recorded by hand
        const lower = lowerOf(r as Row);
        const res: Deduction =
          kind === 'tds'
            ? computeTds({
                section: rule,
                date,
                basePaise: base,
                pan: s(r['pan']),
                ...(r['tds_category']
                  ? { category: s(r['tds_category']) as 'individual_huf' | 'other' }
                  : {}),
                ...(r['tds_kind']
                  ? { kind: s(r['tds_kind']) as 'professional' | 'technical' }
                  : {}),
                cumulativeBeforePaise: before,
                alreadyBasePaise: taxed.get(key) ?? 0n,
                lower: lower ? { ...lower, usedPaise: lowerUsed.get(key) ?? 0n } : null,
                ...(priorTurnover > 0n ? { buyerTurnoverPaise: priorTurnover } : {}),
              })
            : computeTcs({
                nature: rule,
                date,
                basePaise: base,
                pan: s(r['pan']),
                cumulativeBeforePaise: before,
              });
        if (!res.applies) continue;
        taxed.set(key, (taxed.get(key) ?? 0n) + res.basePaise);
        if (res.lowerCert) lowerUsed.set(key, (lowerUsed.get(key) ?? 0n) + res.basePaise);
        out.push({
          kind,
          partyId: s(r['party_id']),
          partyName: s(r['party_name']),
          documentId: s(r['id']),
          documentNumber: s(r['number']),
          date,
          section: kind === 'tds' ? rule : '206C(1)',
          nature: kind === 'tcs' ? rule : null,
          basePaise: res.basePaise,
          rateBp: res.rateBp,
          taxPaise: res.taxPaise,
          noPan: res.noPan,
          lowerCert: res.lowerCert,
          why: res.why,
        });
      }
      return out;
    });
  }

  /**
   * Work out a deduction by hand for one party and date: the same rules, with the year's position read from
   * the documents and the deductions already recorded. Used to fill the form before it is saved.
   */
  async preview(ctx: Ctx, m: ManualInput): Promise<Deduction> {
    return runInTx(this.d, ctx, async (tx) => {
      const fy = fyOfDate(m.date);
      const start = fyStartYear(fy);
      const pr = await queryRows(
        this.d,
        tx,
        sql`SELECT * FROM parties WHERE id = ${m.partyId} AND business_id = ${ctx.businessId}`,
      );
      const p = pr[0] as Row | undefined;
      if (!p) throw new RuleError('That party was not found.');
      const types = m.kind === 'tds' ? PURCHASE_TYPES : SALE_TYPES;
      const typeList = sql.join(
        types.map((t) => sql`${t}`),
        sql`, `,
      );
      const cum = await queryRows(
        this.d,
        tx,
        sql`SELECT coalesce(sum(CASE WHEN total_taxable_paise > 0 THEN total_taxable_paise ELSE total_paise END), 0) AS v
            FROM documents
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND status = 'issued' AND party_id = ${m.partyId}
              AND type IN (${typeList}) AND date >= ${`${start}-04-01`} AND date < ${m.date}`,
      );
      const rule = m.rule;
      const ded = await queryRows(
        this.d,
        tx,
        sql`SELECT coalesce(sum(base_paise), 0) AS v, coalesce(sum(CASE WHEN lower_cert THEN base_paise ELSE 0 END), 0) AS l
            FROM tax_deductions
            WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND party_id = ${m.partyId}
              AND kind = ${m.kind} AND fy = ${fy} AND ${m.kind === 'tds' ? sql`section` : sql`nature`} = ${rule}`,
      );
      const before = b(cum[0]?.['v']);
      if (m.kind === 'tcs')
        return computeTcs({
          nature: rule,
          date: m.date,
          basePaise: m.basePaise,
          pan: s(p['pan']),
          cumulativeBeforePaise: before,
        });
      const lower = lowerOf(p);
      return computeTds({
        section: rule,
        date: m.date,
        basePaise: m.basePaise,
        pan: s(p['pan']),
        ...(p['tds_category']
          ? { category: s(p['tds_category']) as 'individual_huf' | 'other' }
          : {}),
        ...(p['tds_kind'] ? { kind: s(p['tds_kind']) as 'professional' | 'technical' } : {}),
        cumulativeBeforePaise: before,
        alreadyBasePaise: b(ded[0]?.['v']),
        lower: lower ? { ...lower, usedPaise: b(ded[0]?.['l']) } : null,
      });
    });
  }

  /** Record a deduction or collection (a suggestion accepted, or one entered by hand). */
  async record(
    ctx: Ctx,
    p: Pick<
      Proposal,
      | 'kind'
      | 'partyId'
      | 'section'
      | 'nature'
      | 'date'
      | 'basePaise'
      | 'rateBp'
      | 'taxPaise'
      | 'noPan'
      | 'lowerCert'
    > & {
      documentId?: string | null;
      note?: string;
    },
  ): Promise<Row> {
    if (p.taxPaise < 0n || p.basePaise < 0n) throw new RuleError('The amounts cannot be negative.');
    const q = quarterOf(p.date);
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (p.documentId) {
        const existing = await queryRows(
          this.d,
          tx,
          sql`SELECT id FROM tax_deductions WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL
                AND document_id = ${p.documentId} AND kind = ${p.kind}`,
        );
        if (existing.length > 0)
          throw new RuleError('Tax is already recorded against this document.');
      }
      return this.deductionRows.create(c, {
        kind: p.kind,
        party_id: p.partyId,
        document_id: p.documentId ?? null,
        section: p.section,
        nature: p.nature,
        date: p.date,
        fy: q.fy,
        quarter: q.quarter,
        base_paise: p.basePaise,
        rate_bp: p.rateBp,
        tax_paise: p.taxPaise,
        no_pan: p.noPan,
        lower_cert: p.lowerCert,
        note: p.note ?? null,
      } as never);
    });
  }

  /** Remove a recorded deduction (it goes to the trash; the audit log keeps it). */
  async removeDeduction(ctx: Ctx, id: string, expectedVersion: number): Promise<void> {
    await this.deductionRows.softDelete(ctx, id, expectedVersion);
  }

  async addChallan(ctx: Ctx, c: NewChallan): Promise<Row> {
    if (!/^\d{7}$/.test(c.bsr.trim())) throw new RuleError('The BSR code is 7 digits.');
    if (!c.serial.trim()) throw new RuleError('Enter the challan serial number.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.depositDate))
      throw new RuleError('Enter the date of deposit.');
    if (c.taxPaise <= 0n) throw new RuleError('The tax deposited must be more than nothing.');
    return this.challanRows.create(ctx, {
      kind: c.kind,
      fy: c.fy,
      quarter: c.quarter,
      section: c.section ?? null,
      bsr_code: c.bsr.trim(),
      deposit_date: c.depositDate,
      serial: c.serial.trim(),
      tax_paise: c.taxPaise,
      interest_paise: c.interestPaise ?? 0n,
      fee_paise: c.feePaise ?? 0n,
      note: c.note ?? null,
    } as never);
  }

  async removeChallan(ctx: Ctx, id: string, expectedVersion: number): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT id, version FROM tax_deductions WHERE business_id = ${ctx.businessId} AND deleted_at IS NULL AND challan_id = ${id}`,
      );
      for (const r of rows)
        await this.deductionRows.update(
          c,
          s(r['id']),
          { challan_id: null } as never,
          n(r['version']),
        );
      await this.challanRows.softDelete(c, id, expectedVersion);
    });
  }

  /** Match deductions to the challan that paid them (or clear the match with `null`). */
  async mapToChallan(ctx: Ctx, deductionIds: string[], challanId: string | null): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      let kind: string | null = null;
      if (challanId) {
        const ch = await this.challanRows.get(c, challanId);
        if (!ch) throw new RuleError('That challan was not found.');
        kind = s(ch['kind']);
      }
      for (const id of deductionIds) {
        const row = await this.deductionRows.get(c, id);
        if (!row) throw new RuleError('A deduction was not found.');
        if (kind && s(row['kind']) !== kind)
          throw new RuleError('A TDS challan cannot pay TCS, and the other way round.');
        await this.deductionRows.update(
          c,
          id,
          { challan_id: challanId } as never,
          n(row['version']),
        );
      }
    });
  }

  async receivables(ctx: Ctx, fy?: string): Promise<ReceivableRow[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT r.*, p.name AS party_name FROM tds_receivable r JOIN parties p ON p.id = r.party_id
            WHERE r.business_id = ${ctx.businessId} AND r.deleted_at IS NULL
            ORDER BY r.date DESC, r.id`,
      );
      return rows
        .filter((r) => !fy || r['fy'] === fy)
        .map((r) => ({
          id: s(r['id']),
          partyId: s(r['party_id']),
          partyName: s(r['party_name']),
          fy: s(r['fy']),
          quarter: s(r['quarter']),
          section: s(r['section']),
          date: s(r['date']),
          grossPaise: b(r['gross_paise']),
          tdsPaise: b(r['tds_paise']),
          certificateNo: s(r['certificate_no']),
          status: s(r['status']) as ReceivableRow['status'],
        }));
    });
  }

  async addReceivable(
    ctx: Ctx,
    r: {
      partyId: string;
      section: string;
      date: string;
      grossPaise: bigint;
      tdsPaise: bigint;
      note?: string;
    },
  ): Promise<Row> {
    if (r.tdsPaise <= 0n) throw new RuleError('Enter the tax the customer deducted.');
    if (r.tdsPaise > r.grossPaise)
      throw new RuleError('The tax cannot be more than the amount paid.');
    const q = quarterOf(r.date);
    return this.receivableRows.create(ctx, {
      party_id: r.partyId,
      fy: q.fy,
      quarter: q.quarter,
      section: r.section,
      date: r.date,
      gross_paise: r.grossPaise,
      tds_paise: r.tdsPaise,
      note: r.note ?? null,
    } as never);
  }

  async setReceivableStatus(
    ctx: Ctx,
    id: string,
    status: ReceivableRow['status'],
    cert?: { no: string; date: string },
  ): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const row = await this.receivableRows.get(c, id);
      if (!row) throw new RuleError('That entry was not found.');
      if (status !== 'expected' && !(cert?.no.trim() || s(row['certificate_no'])))
        throw new RuleError('Enter the certificate number (Form 16A) first.');
      return this.receivableRows.update(
        c,
        id,
        {
          status,
          ...(cert ? { certificate_no: cert.no.trim(), certificate_date: cert.date } : {}),
        } as never,
        n(row['version']),
      );
    });
  }

  async removeReceivable(ctx: Ctx, id: string, expectedVersion: number): Promise<void> {
    await this.receivableRows.softDelete(ctx, id, expectedVersion);
  }
}
