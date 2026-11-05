/**
 * GST returns (prompt 30): reads the documents of a period into the shape the GSTR-1 and GSTR-3B
 * builders in `@gst/domain` take, and records what a person did with each return (exported, filed
 * with an ARN) and any ITC adjustment they made. The arithmetic is not here; it is in the domain
 * package so it can be tested without a database.
 */
import {
  ITC_FIELDS,
  monthPeriod,
  returnsUqc,
  reviewPeriod,
  type GstrDoc,
  type GstrDocType,
  type GstrLine,
  type GstrPeriod,
  type GstrTaxability,
  type PeriodAdjustment,
  type PeriodReview,
  type Return,
} from '@gst/domain';
import { sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import type { Row } from '../schema';

import { BaseRepo, RuleError, runInTx, type Ctx } from './base';

const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));
const flag = (v: unknown): boolean => v === true || Number(v) === 1;

const RETURN_DOC_TYPES = [
  'tax_invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'receipt_voucher',
  'purchase_bill',
  'purchase_return',
] as const;

export interface BusinessGstInfo {
  gstin: string;
  stateCode: string;
  scheme: 'regular' | 'composition';
}

export interface FilingRecord {
  returnType: Return;
  fp: string;
  status: 'open' | 'exported' | 'filed';
  exportedAt: number | null;
  schemaVersion: string | null;
  arn: string | null;
  filedOn: string | null;
  dueOverride: string | null;
  id: string;
  version: number;
}

const toFiling = (r: Row): FilingRecord => ({
  returnType: r['return_type'] as Return,
  fp: s(r['period_fp']),
  status: r['status'] as FilingRecord['status'],
  exportedAt: r['exported_at'] == null ? null : n(r['exported_at']),
  schemaVersion: r['schema_version'] == null ? null : s(r['schema_version']),
  arn: r['arn'] == null ? null : s(r['arn']),
  filedOn: r['filed_on'] == null ? null : s(r['filed_on']),
  dueOverride: r['due_override'] == null ? null : s(r['due_override']),
  id: s(r['id']),
  version: n(r['version']),
});

class FilingRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'gst_filings');
  }
  async find(ctx: Ctx, returnType: Return, fp: string): Promise<Row | null> {
    const rows = await this.list(ctx);
    return rows.find((r) => r['return_type'] === returnType && r['period_fp'] === fp) ?? null;
  }
  upsert(
    tx: any,
    ctx: Ctx,
    period: GstrPeriod,
    returnType: Return,
    patch: Record<string, unknown>,
  ) {
    return this.findIn(tx, ctx, returnType, period.fp).then((existing) =>
      existing
        ? this.updateIn(tx, ctx, s(existing['id']), patch, n(existing['version']))
        : this.createIn(tx, ctx, {
            return_type: returnType,
            period_fp: period.fp,
            period_from: period.from,
            period_to: period.to,
            ...patch,
          }),
    );
  }
  private async findIn(tx: any, ctx: Ctx, returnType: Return, fp: string): Promise<Row | null> {
    return this.find({ ...ctx, tx }, returnType, fp);
  }
}

class AdjustmentRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'gst_adjustments');
  }
}

export class GstrRepo {
  private readonly filings: FilingRows;
  private readonly adjust: AdjustmentRows;

  constructor(private readonly d: Database) {
    this.filings = new FilingRows(d);
    this.adjust = new AdjustmentRows(d);
  }

  async businessInfo(ctx: Ctx): Promise<BusinessGstInfo> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT gstin, state_code, scheme FROM businesses WHERE id = ${ctx.businessId}`,
      );
      const r = rows[0] ?? {};
      return {
        gstin: s(r['gstin']),
        stateCode: s(r['state_code']),
        scheme: r['scheme'] === 'composition' ? 'composition' : 'regular',
      };
    });
  }

  /** Issued and cancelled documents dated in the range, with their lines, in the builders' shape. */
  async loadDocs(ctx: Ctx, from: string, to: string): Promise<GstrDoc[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const types = sql.join(
        RETURN_DOC_TYPES.map((t) => sql`${t}`),
        sql`, `,
      );
      const info = await this.businessInfo({ ...ctx, tx });
      const heads = await queryRows(
        this.d,
        tx,
        sql`SELECT d.id, d.type, d.status, d.number, d.date, d.party_name, d.place_of_supply_state AS pos,
                   d.supply_type, d.reverse_charge, d.total_paise, d.metadata_json,
                   coalesce(ns.series_key, cast(d.series_id as text), '') AS series,
                   coalesce(pa.gstin, '') AS gstin, pa.is_unregistered AS unreg,
                   pa.is_composition AS comp, coalesce(pa.state_code, '') AS pstate,
                   coalesce(src.number, '') AS link_number, coalesce(cast(src.date as text), '') AS link_date,
                   coalesce(src.total_paise, 0) AS link_total
            FROM documents d
            LEFT JOIN number_series ns ON ns.id = d.series_id
            LEFT JOIN parties pa ON pa.id = d.party_id
            LEFT JOIN documents src ON src.id = d.source_document_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL
              AND d.status IN ('issued', 'cancelled') AND d.number IS NOT NULL
              AND d.type IN (${types}) AND d.date >= ${from} AND d.date <= ${to}
            ORDER BY d.date, d.number, d.id`,
      );
      const lineRows = await queryRows(
        this.d,
        tx,
        sql`SELECT l.document_id, coalesce(l.hsn, '') AS hsn, coalesce(l.description, '') AS description,
                   l.qty_micros, l.taxable_paise, l.taxability,
                   (l.cgst_bp + l.sgst_bp + l.utgst_bp + l.igst_bp) AS rate_bp,
                   l.igst_paise, l.cgst_paise, (l.sgst_paise + l.utgst_paise) AS sgst_paise, l.cess_paise,
                   u.code AS unit_code, u.uqc AS unit_uqc, u.is_custom AS unit_custom
            FROM document_lines l
            JOIN documents d ON d.id = l.document_id
            LEFT JOIN units u ON u.id = l.unit_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND l.deleted_at IS NULL
              AND d.status IN ('issued', 'cancelled') AND d.number IS NOT NULL
              AND d.type IN (${types}) AND d.date >= ${from} AND d.date <= ${to}
            ORDER BY l.document_id, l.line_no`,
      );
      const byDoc = new Map<string, GstrLine[]>();
      for (const r of lineRows) {
        const unit = r['unit_code']
          ? returnsUqc({
              code: s(r['unit_code']),
              uqc: r['unit_uqc'] == null ? null : s(r['unit_uqc']),
              is_custom: flag(r['unit_custom']),
            })
          : 'OTH';
        const arr = byDoc.get(s(r['document_id'])) ?? [];
        arr.push({
          hsn: s(r['hsn']),
          description: s(r['description']),
          uqc: unit,
          qtyMicros: n(r['qty_micros']),
          taxablePaise: n(r['taxable_paise']),
          rateBp: n(r['rate_bp']),
          igstPaise: n(r['igst_paise']),
          cgstPaise: n(r['cgst_paise']),
          sgstPaise: n(r['sgst_paise']),
          cessPaise: n(r['cess_paise']),
          taxability: s(r['taxability']) as GstrTaxability,
        });
        byDoc.set(s(r['document_id']), arr);
      }
      return heads.map((h): GstrDoc => {
        const meta = parseMeta(h['metadata_json']);
        const gstin = s(h['gstin']);
        const supply = s(h['supply_type']);
        return {
          id: s(h['id']),
          type: s(h['type']) as GstrDocType,
          status: h['status'] === 'cancelled' ? 'cancelled' : 'issued',
          number: s(h['number']),
          seriesKey: s(h['series']),
          date: s(h['date']),
          partyName: s(h['party_name']),
          partyGstin: gstin,
          registered: gstin !== '' && !flag(h['unreg']),
          partyComposition: flag(h['comp']),
          partyState: s(h['pstate']),
          pos: s(h['pos']),
          supplierState: info.stateCode,
          supplyType: (['intra', 'inter', 'export', 'sez'].includes(supply)
            ? supply
            : 'intra') as GstrDoc['supplyType'],
          lut: meta['lut'] === true,
          reverseCharge: flag(h['reverse_charge']),
          totalPaise: n(h['total_paise']),
          linkedNumber: s(h['link_number']),
          linkedDate: s(h['link_date']),
          linkedTotalPaise: n(h['link_total']),
          lines: byDoc.get(s(h['id'])) ?? [],
        };
      });
    });
  }

  /** Both returns for a period with every issue found. `minHsnDigits` follows the turnover rule. */
  async review(
    ctx: Ctx,
    period: GstrPeriod,
    opts: { minHsnDigits?: number } = {},
  ): Promise<PeriodReview> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const info = await this.businessInfo(c);
      const docs = await this.loadDocs(c, period.from, period.to);
      const adjustments = await this.listAdjustments(c, period.fp);
      return reviewPeriod(period, docs, adjustments, {
        gstin: period.gstin || info.gstin,
        scheme: info.scheme,
        minHsnDigits: opts.minHsnDigits ?? 4,
      });
    });
  }

  /**
   * The checks for last month and this month, for the inbox. Empty when the business has no GSTIN or is
   * a composition business (which does not file these returns). `today` is an IST day, `YYYY-MM-DD`.
   */
  async recentIssues(
    ctx: Ctx,
    today: string,
  ): Promise<{ fp: string; issues: PeriodReview['issues'] }[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const info = await this.businessInfo(c);
      if (!info.gstin || info.scheme !== 'regular') return [];
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));
      const periods = [
        monthPeriod(info.gstin, month === 1 ? year - 1 : year, month === 1 ? 12 : month - 1),
        monthPeriod(info.gstin, year, month),
      ];
      const out: { fp: string; issues: PeriodReview['issues'] }[] = [];
      for (const p of periods) out.push({ fp: p.fp, issues: (await this.review(c, p)).issues });
      return out;
    });
  }

  /* ------------------------------------------------------------ filing state */

  async listFilings(ctx: Ctx): Promise<FilingRecord[]> {
    return runInTx(this.d, ctx, async (tx) =>
      (await this.filings.list({ ...ctx, tx })).map(toFiling),
    );
  }

  async markExported(
    ctx: Ctx,
    returnType: Return,
    period: GstrPeriod,
    schemaVersion: string,
  ): Promise<FilingRecord> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const cur = await this.filings.find(c, returnType, period.fp);
      // an export after filing (for a copy) must not move a filed return back
      const status = cur?.['status'] === 'filed' ? 'filed' : 'exported';
      return toFiling(
        await this.filings.upsert(tx, c, period, returnType, {
          status,
          exported_at: Date.now(),
          schema_version: schemaVersion,
        }),
      );
    });
  }

  async markFiled(
    ctx: Ctx,
    returnType: Return,
    period: GstrPeriod,
    input: { arn: string; filedOn: string },
  ): Promise<FilingRecord> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const arn = input.arn.trim().toUpperCase();
      if (!/^[A-Z0-9]{8,20}$/.test(arn))
        throw new RuleError(
          'Enter the acknowledgement reference number (ARN) the GST portal gave you.',
        );
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.filedOn))
        throw new RuleError('Enter the date the return was filed.');
      if (input.filedOn <= period.to)
        throw new RuleError('A return cannot be filed before its period has ended.');
      return toFiling(
        await this.filings.upsert(tx, c, period, returnType, {
          status: 'filed',
          arn,
          filed_on: input.filedOn,
        }),
      );
    });
  }

  /** Undo "filed" (for example it was recorded against the wrong period). Needs a reason, kept in the audit trail. */
  async reopen(
    ctx: Ctx,
    returnType: Return,
    period: GstrPeriod,
    reason: string,
  ): Promise<FilingRecord> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (!reason.trim()) throw new RuleError('Say why the filing is being reopened.');
      const cur = await this.filings.find(c, returnType, period.fp);
      if (!cur || cur['status'] !== 'filed')
        throw new RuleError('This return is not marked as filed.');
      return toFiling(
        await this.filings.upsert(tx, c, period, returnType, {
          status: 'exported',
          arn: null,
          filed_on: null,
          note: `Reopened: ${reason.trim()}`,
        }),
      );
    });
  }

  async setDueOverride(
    ctx: Ctx,
    returnType: Return,
    period: GstrPeriod,
    date: string | null,
  ): Promise<FilingRecord> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new RuleError('Enter a valid due date.');
      return toFiling(await this.filings.upsert(tx, c, period, returnType, { due_override: date }));
    });
  }

  /* ------------------------------------------------------------ ITC adjustments */

  async listAdjustments(ctx: Ctx, fp: string): Promise<PeriodAdjustment[]> {
    return runInTx(this.d, ctx, async (tx) =>
      (await this.adjust.list({ ...ctx, tx }))
        .filter((r) => r['period_fp'] === fp)
        .map(toAdjustment),
    );
  }

  /** Rows with ids, for the review screen (so one can be removed). */
  async listAdjustmentRows(
    ctx: Ctx,
    fp: string,
  ): Promise<(PeriodAdjustment & { id: string; version: number })[]> {
    return runInTx(this.d, ctx, async (tx) =>
      (await this.adjust.list({ ...ctx, tx }))
        .filter((r) => r['period_fp'] === fp)
        .map((r) => ({ ...toAdjustment(r), id: s(r['id']), version: n(r['version']) })),
    );
  }

  async addAdjustment(ctx: Ctx, fp: string, adj: PeriodAdjustment): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const field = adj.field.replace(/^itc\./, '');
      if (!(ITC_FIELDS as readonly string[]).includes(field))
        throw new RuleError('That ITC field does not exist.');
      if (!adj.reason.trim()) throw new RuleError('Say why the figure is being changed.');
      if (![adj.iamt, adj.camt, adj.samt, adj.csamt].every(Number.isSafeInteger))
        throw new RuleError('Amounts must be whole paise.');
      return this.adjust.create(c, {
        period_fp: fp,
        field: `itc.${field}`,
        igst_paise: adj.iamt,
        cgst_paise: adj.camt,
        sgst_paise: adj.samt,
        cess_paise: adj.csamt,
        reason: adj.reason.trim(),
      });
    });
  }

  async removeAdjustment(ctx: Ctx, id: string, expectedVersion: number): Promise<Row> {
    return runInTx(this.d, ctx, async (tx) =>
      this.adjust.softDelete({ ...ctx, tx }, id, expectedVersion),
    );
  }
}

function toAdjustment(r: Row): PeriodAdjustment {
  return {
    field: s(r['field']),
    iamt: n(r['igst_paise']),
    camt: n(r['cgst_paise']),
    samt: n(r['sgst_paise']),
    csamt: n(r['cess_paise']),
    reason: s(r['reason']),
  };
}

function parseMeta(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string' && v) {
    try {
      const p = JSON.parse(v) as unknown;
      return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}
