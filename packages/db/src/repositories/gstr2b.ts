/**
 * GSTR-2B reconciliation (prompt 31): stores the imported 2B, loads the purchase bills to match it with,
 * runs the matching engine in `@gst/domain`, and records what a person decided. The matching itself is
 * not here; it is pure domain code so it can be tested without a database.
 *
 * - Importing a period again replaces it (the earlier lines are moved to the trash in the same
 *   transaction, so a failed import leaves the old one in place).
 * - Decisions (accept, link by hand, supplier to file, ignore) are kept against a key that survives a
 *   re-import: the supplier GSTIN, the comparable number and the type.
 * - Lines and bills not matched are carried into the next three months' reconciliations.
 */
import {
  DEFAULT_RECON_OPTIONS,
  addDaysIso,
  adjustmentsFor,
  explain,
  numberKey,
  pairMatch,
  periodsBetween,
  reconcile,
  summarise,
  type BookBill,
  type Entry2B,
  type Explanation,
  type GstrPeriod,
  type Match,
  type ParsedReturn2B,
  type PeriodAdjustment,
  type ReconOptions,
  type Summary,
} from '@gst/domain';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { queryRows, type Database } from '../database';
import { noteWrite } from '../events';

import { SettingsRepo } from './aggregates';
import { BaseRepo, RuleError, newId, runInTx, writeAudit, type Ctx } from './base';
import { GstrRepo } from './gstr';

const OPTIONS_KEY = 'gst.recon.options';
const n = (v: unknown): number => Number(v ?? 0);
const s = (v: unknown): string => (v == null ? '' : String(v));
const flag = (v: unknown): boolean => v === true || Number(v) === 1;

export type DecisionKind = 'accept' | 'link' | 'supplier_to_file' | 'ignore';

export interface ReconDecision {
  id: string;
  version: number;
  decision: DecisionKind;
  linkedDocumentId: string | null;
  note: string;
}

export interface ReconRow {
  /** `entryId|billId`, unique within a workspace. */
  key: string;
  match: Match;
  entry: Entry2B | null;
  bill: BookBill | null;
  /** From an earlier month: still unmatched and carried forward. */
  carried: boolean;
  decision: ReconDecision | null;
  /** The `decisions` key of the side a decision on this row is kept against. */
  decisionRef: { side: 'entry' | 'bill'; refKey: string };
  explanation: Explanation;
}

export interface ImportInfo {
  id: string;
  period: string;
  source: string;
  parserVersion: string;
  entryCount: number;
  problems: string[];
  importedAt: number;
}

export interface ReconWorkspace {
  period: GstrPeriod;
  rows: ReconRow[];
  summary: Summary;
  imports: ImportInfo[];
  /** Whether a 2B has been imported for this period itself. */
  hasImport: boolean;
}

/** The key a decision on a 2B line is kept against: it survives importing the period again. */
export const entryRefKey = (e: {
  supplierGstin: string;
  number: string;
  docType: string;
}): string => `${e.supplierGstin.toUpperCase()}|${numberKey(e.number)}|${e.docType}`;

const CLASS_ORDER: Record<Match['cls'], number> = {
  matched_with_differences: 0,
  in_2b_not_in_books: 1,
  in_books_not_in_2b: 2,
  duplicate_in_books: 3,
  matched: 4,
};

class ImportRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'gstr2b_imports');
  }
}
class DecisionRows extends BaseRepo {
  constructor(d: Database) {
    super(d, 'gstr2b_decisions');
  }
}

export class Gstr2bRepo {
  private readonly imports: ImportRows;
  private readonly decisions: DecisionRows;
  private readonly gstr: GstrRepo;

  constructor(private readonly d: Database) {
    this.imports = new ImportRows(d);
    this.decisions = new DecisionRows(d);
    this.gstr = new GstrRepo(d);
  }

  /* ------------------------------------------------------------ matching tolerances */

  /** How strict the matching is: the business's own settings over the defaults. */
  async options(ctx: Ctx): Promise<ReconOptions> {
    return runInTx(this.d, ctx, async (tx) => {
      const saved = await new SettingsRepo(this.d).getValue<Partial<ReconOptions>>(
        { ...ctx, tx },
        OPTIONS_KEY,
      );
      const o = { ...DEFAULT_RECON_OPTIONS };
      for (const k of Object.keys(o) as (keyof ReconOptions)[]) {
        const v = saved?.[k];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) o[k] = v;
      }
      return o;
    });
  }

  /** Save the tolerances. Whole numbers only, within sensible limits; anything else is refused. */
  async setOptions(ctx: Ctx, o: ReconOptions): Promise<ReconOptions> {
    return runInTx(this.d, ctx, async (tx) => {
      const limits: Record<keyof ReconOptions, [number, number, string]> = {
        exactDateDays: [0, 31, 'The days allowed for an exact match must be from 0 to 31.'],
        fuzzyDateDays: [0, 180, 'The widest date gap must be from 0 to 180 days.'],
        amountTolerancePaise: [
          0,
          10_000_000,
          'The amount tolerance must be from 0 to INR 1,00,000.',
        ],
        amountToleranceBp: [0, 1_000, 'The percentage tolerance must be from 0% to 10%.'],
      };
      for (const k of Object.keys(limits) as (keyof ReconOptions)[]) {
        const [lo, hi, message] = limits[k];
        const v = o[k];
        if (!Number.isInteger(v) || v < lo || v > hi) throw new RuleError(message);
      }
      if (o.fuzzyDateDays < o.exactDateDays)
        throw new RuleError('The widest date gap cannot be smaller than the exact-match gap.');
      await new SettingsRepo(this.d).set({ ...ctx, tx }, OPTIONS_KEY, o);
      return o;
    });
  }

  /* ------------------------------------------------------------ importing */

  /**
   * Store a parsed GSTR-2B, replacing any earlier import of the same period. Refuses a file for another
   * GSTIN, one with no readable lines, and one whose period cannot be told.
   */
  async importReturn(
    ctx: Ctx,
    parsed: ParsedReturn2B,
    meta: { source: 'json' | 'xlsx'; fileHash?: string; period?: string },
  ): Promise<{
    importId: string;
    count: number;
    period: string;
    problems: string[];
    reverseChargeLeftOut: number;
  }> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const info = await this.gstr.businessInfo(c);
      const period = meta.period ?? parsed.period;
      if (!/^(0[1-9]|1[0-2])\d{4}$/.test(period))
        throw new RuleError('Could not tell which month this GSTR-2B is for. Choose the month.');
      if (parsed.gstin && info.gstin && parsed.gstin.toUpperCase() !== info.gstin.toUpperCase())
        throw new RuleError(
          `This GSTR-2B is for GSTIN ${parsed.gstin}, but this business is ${info.gstin}.`,
        );
      if (parsed.entries.length === 0)
        throw new RuleError(parsed.problems[0] ?? 'No supplier documents were found in this file.');

      const t = this.d.schema.gstr2b_entries;
      const now = Date.now();
      // the earlier import of this period goes to the trash first, inside this transaction
      await tx
        .update(t)
        .set({ deleted_at: now, updated_at: now, updated_by: ctx.actor })
        .where(
          and(eq(t.business_id, ctx.businessId), eq(t.period_fp, period), isNull(t.deleted_at)),
        );
      const ti = this.d.schema.gstr2b_imports;
      await tx
        .update(ti)
        .set({ deleted_at: now, updated_at: now, updated_by: ctx.actor })
        .where(
          and(eq(ti.business_id, ctx.businessId), eq(ti.period_fp, period), isNull(ti.deleted_at)),
        );
      noteWrite(tx, 'gstr2b_entries');

      const imp = await this.imports.create(c, {
        period_fp: period,
        gstin: parsed.gstin || info.gstin,
        source: meta.source,
        parser_version: parsed.version,
        file_hash: meta.fileHash ?? null,
        entry_count: parsed.entries.length,
        problems_json: parsed.problems,
      });
      for (let i = 0; i < parsed.entries.length; i += 200) {
        const at = Date.now();
        await tx.insert(t).values(
          parsed.entries.slice(i, i + 200).map((e) => ({
            id: newId(),
            org_id: ctx.orgId,
            business_id: ctx.businessId,
            version: 1,
            created_at: at,
            updated_at: at,
            created_by: ctx.actor,
            updated_by: ctx.actor,
            import_id: s(imp['id']),
            period_fp: period,
            supplier_gstin: e.supplierGstin.toUpperCase(),
            supplier_name: e.supplierName,
            doc_type: e.docType,
            number: e.number,
            number_key: numberKey(e.number),
            date: e.date,
            taxable_paise: e.taxable,
            igst_paise: e.igst,
            cgst_paise: e.cgst,
            sgst_paise: e.sgst,
            cess_paise: e.cess,
            itc_available: e.itcAvailable,
            reason: e.reason,
            supplier_period: e.supplierPeriod,
          })),
        );
      }
      await writeAudit(this.d, tx, c, 'gstr2b_imports', s(imp['id']), 'insert', null, {
        period,
        source: meta.source,
        entries: parsed.entries.length,
      });
      return {
        importId: s(imp['id']),
        count: parsed.entries.length,
        period,
        problems: parsed.problems,
        reverseChargeLeftOut: parsed.reverseChargeLeftOut ?? 0,
      };
    });
  }

  async listImports(ctx: Ctx): Promise<ImportInfo[]> {
    return runInTx(this.d, ctx, async (tx) =>
      (await this.imports.list({ ...ctx, tx }))
        .map((r) => ({
          id: s(r['id']),
          period: s(r['period_fp']),
          source: s(r['source']),
          parserVersion: s(r['parser_version']),
          entryCount: n(r['entry_count']),
          problems: Array.isArray(r['problems_json']) ? (r['problems_json'] as string[]) : [],
          importedAt: n(r['created_at']),
        }))
        .sort(
          (a, b) =>
            b.period.slice(2).localeCompare(a.period.slice(2)) || b.period.localeCompare(a.period),
        ),
    );
  }

  /* ------------------------------------------------------------ loading */

  private async loadEntries(ctx: Ctx, fps: string[]): Promise<Entry2B[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const t = this.d.schema.gstr2b_entries;
      const rows: Record<string, unknown>[] = await tx
        .select()
        .from(t)
        .where(
          and(eq(t.business_id, ctx.businessId), isNull(t.deleted_at), inArray(t.period_fp, fps)),
        );
      return rows.map((r): Entry2B => ({
        id: s(r['id']),
        supplierGstin: s(r['supplier_gstin']),
        supplierName: s(r['supplier_name']),
        docType: s(r['doc_type']) as Entry2B['docType'],
        number: s(r['number']),
        date: s(r['date']),
        taxable: n(r['taxable_paise']),
        igst: n(r['igst_paise']),
        cgst: n(r['cgst_paise']),
        sgst: n(r['sgst_paise']),
        cess: n(r['cess_paise']),
        itcAvailable: (s(r['itc_available']) as Entry2B['itcAvailable']) || '',
        reason: s(r['reason']),
        supplierPeriod: s(r['supplier_period']),
        period: s(r['period_fp']),
      }));
    });
  }

  /**
   * Purchase bills and returns in the range that can carry credit from the supplier: issued, from a
   * supplier with a GSTIN, not reverse charge (credit on those is claimed another way). The number and
   * date compared are the supplier's own, which the editor keeps in the bill's details.
   */
  async loadBooks(ctx: Ctx, from: string, to: string): Promise<BookBill[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const rows = await queryRows(
        this.d,
        tx,
        sql`SELECT d.id, d.type, d.number, d.date, d.reverse_charge, d.metadata_json,
                   d.total_taxable_paise AS taxable, d.total_igst_paise AS igst, d.total_cgst_paise AS cgst,
                   (d.total_sgst_paise + d.total_utgst_paise) AS sgst, d.total_cess_paise AS cess,
                   coalesce(pa.gstin, '') AS gstin
            FROM documents d JOIN parties pa ON pa.id = d.party_id
            WHERE d.business_id = ${ctx.businessId} AND d.deleted_at IS NULL AND d.status = 'issued'
              AND d.type IN ('purchase_bill', 'purchase_return') AND d.date >= ${from} AND d.date <= ${to}
            ORDER BY d.date, d.number, d.id`,
      );
      const out: BookBill[] = [];
      for (const r of rows) {
        const gstin = s(r['gstin']).trim();
        if (!gstin || flag(r['reverse_charge'])) continue;
        const meta = parseMeta(r['metadata_json']);
        const number = s(meta['supplierInvoiceNo']).trim() || s(r['number']);
        if (!number) continue;
        out.push({
          id: s(r['id']),
          supplierGstin: gstin.toUpperCase(),
          number,
          date: s(meta['supplierInvoiceDate']) || s(r['date']),
          type: s(r['type']) === 'purchase_return' ? 'purchase_return' : 'purchase_bill',
          itcEligible: meta['itcEligible'] !== false,
          taxable: n(r['taxable']),
          igst: n(r['igst']),
          cgst: n(r['cgst']),
          sgst: n(r['sgst']),
          cess: n(r['cess']),
        });
      }
      return out;
    });
  }

  private async loadDecisions(ctx: Ctx, fps: string[]): Promise<Map<string, ReconDecision>> {
    return runInTx(this.d, ctx, async (tx) => {
      const out = new Map<string, ReconDecision>();
      for (const r of await this.decisions.list({ ...ctx, tx })) {
        if (!fps.includes(s(r['period_fp']))) continue;
        out.set(`${s(r['side'])}:${s(r['ref_key'])}`, {
          id: s(r['id']),
          version: n(r['version']),
          decision: s(r['decision']) as DecisionKind,
          linkedDocumentId: r['linked_document_id'] ? s(r['linked_document_id']) : null,
          note: s(r['note']),
        });
      }
      return out;
    });
  }

  /* ------------------------------------------------------------ the reconciliation */

  /**
   * The reconciliation of a period: this month's 2B and bills together with the three months before it
   * (what was not matched then is carried forward), after the person's decisions are applied.
   */
  async workspace(
    ctx: Ctx,
    period: GstrPeriod,
    options: Partial<ReconOptions> = {},
  ): Promise<ReconWorkspace> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const o: ReconOptions = { ...(await this.options(c)), ...options };
      const window = periodsBetween(period.gstin, addDaysIso(period.from, -92), period.to, 'month');
      const fps = window.map((p) => p.fp);
      const earliest = window[0]!.from;
      const [entries, books, decisions, imports] = await Promise.all([
        this.loadEntries(c, fps),
        this.loadBooks(c, earliest, period.to),
        this.loadDecisions(c, fps),
        this.listImports(c),
      ]);
      const entryById = new Map(entries.map((e) => [e.id, e]));
      const billById = new Map(books.map((b) => [b.id, b]));
      const decisionOf = (side: 'entry' | 'bill', ref: string) =>
        decisions.get(`${side}:${ref}`) ?? null;

      // ignored lines and bills leave the reconciliation; hand-made links are paired first
      const ignoredEntries = new Set<string>();
      const ignoredBills = new Set<string>();
      const forced: Match[] = [];
      const usedBills = new Set<string>();
      for (const e of entries) {
        const dec = decisionOf('entry', entryRefKey(e));
        if (!dec) continue;
        if (dec.decision === 'ignore') ignoredEntries.add(e.id);
        else if (dec.decision === 'link' && dec.linkedDocumentId) {
          const b = billById.get(dec.linkedDocumentId);
          if (b && !usedBills.has(b.id)) {
            usedBills.add(b.id);
            ignoredEntries.add(e.id);
            ignoredBills.add(b.id);
            forced.push(pairMatch(e, b, o));
          }
        }
      }
      for (const b of books)
        if (decisionOf('bill', b.id)?.decision === 'ignore') ignoredBills.add(b.id);

      const matches = [
        ...forced,
        ...reconcile(
          entries.filter((e) => !ignoredEntries.has(e.id)),
          books.filter((b) => !ignoredBills.has(b.id)),
          o,
        ),
      ];

      const rows: ReconRow[] = [];
      for (const m of matches) {
        const entry = m.entryId ? (entryById.get(m.entryId) ?? null) : null;
        const bill = m.billId ? (billById.get(m.billId) ?? null) : null;
        const inThisPeriod =
          (entry ? entry.period === period.fp : false) ||
          (bill ? bill.date >= period.from && bill.date <= period.to : false);
        const settled = m.cls === 'matched' || m.cls === 'matched_with_differences';
        // a pair that was settled in an earlier month is history
        if (!inThisPeriod && settled) continue;
        const side = entry ? 'entry' : 'bill';
        const refKey = entry ? entryRefKey(entry) : bill!.id;
        // a decision on the 2B side wins; a bill-only row uses the bill's
        const decision = entry ? decisionOf('entry', refKey) : decisionOf('bill', refKey);
        rows.push({
          key: `${m.entryId ?? ''}|${m.billId ?? ''}`,
          match: m,
          entry,
          bill,
          carried: !inThisPeriod,
          decision,
          decisionRef: { side, refKey },
          explanation: explain(m, entry ?? undefined, bill ?? undefined),
        });
      }
      rows.sort(
        (a, b) =>
          CLASS_ORDER[a.match.cls] - CLASS_ORDER[b.match.cls] ||
          (a.entry?.supplierGstin ?? a.bill?.supplierGstin ?? '').localeCompare(
            b.entry?.supplierGstin ?? b.bill?.supplierGstin ?? '',
          ) ||
          (a.entry?.date ?? a.bill?.date ?? '').localeCompare(
            b.entry?.date ?? b.bill?.date ?? '',
          ) ||
          (a.entry?.number ?? a.bill?.number ?? '').localeCompare(
            b.entry?.number ?? b.bill?.number ?? '',
          ) ||
          a.key.localeCompare(b.key),
      );
      const shown = rows.map((r) => r.match);
      return {
        period,
        rows,
        summary: summarise(shown, entryById, billById),
        imports,
        hasImport: imports.some((i) => i.period === period.fp),
      };
    });
  }

  /* ------------------------------------------------------------ decisions */

  async decide(
    ctx: Ctx,
    fp: string,
    ref: { side: 'entry' | 'bill'; refKey: string },
    decision: DecisionKind,
    opts: { linkedDocumentId?: string; note?: string } = {},
  ): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      if (decision === 'link' && !opts.linkedDocumentId)
        throw new RuleError('Choose the bill to link this line with.');
      const values = {
        period_fp: fp,
        side: ref.side,
        ref_key: ref.refKey,
        decision,
        linked_document_id: decision === 'link' ? (opts.linkedDocumentId ?? null) : null,
        note: opts.note?.trim() || null,
      };
      const cur = (await this.decisions.list(c)).find(
        (r) => r['side'] === ref.side && r['ref_key'] === ref.refKey,
      );
      if (cur) await this.decisions.update(c, s(cur['id']), values, n(cur['version']));
      else await this.decisions.create(c, values);
    });
  }

  async clearDecision(ctx: Ctx, ref: { side: 'entry' | 'bill'; refKey: string }): Promise<void> {
    await runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const cur = (await this.decisions.list(c)).find(
        (r) => r['side'] === ref.side && r['ref_key'] === ref.refKey,
      );
      if (cur) await this.decisions.softDelete(c, s(cur['id']), n(cur['version']));
    });
  }

  /** Accept every exact match that has no decision yet. Returns how many. */
  async acceptMatches(ctx: Ctx, period: GstrPeriod): Promise<number> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const ws = await this.workspace(c, period);
      let count = 0;
      for (const r of ws.rows) {
        if (r.match.cls !== 'matched' || r.decision || r.carried || !r.entry) continue;
        await this.decide(c, period.fp, r.decisionRef, 'accept');
        count += 1;
      }
      return count;
    });
  }

  /**
   * Apply the outcome to GSTR-3B table 4: deferred, duplicate, not-available and excess credit become
   * adjustments of source `reconcile`, replacing the ones from the last time this was applied.
   */
  async applyOutcomes(ctx: Ctx, period: GstrPeriod): Promise<PeriodAdjustment[]> {
    return runInTx(this.d, ctx, async (tx) => {
      const c: Ctx = { ...ctx, tx };
      const ws = await this.workspace(c, period);
      const entries = new Map<string, Entry2B>();
      const books = new Map<string, BookBill>();
      for (const r of ws.rows) {
        if (r.entry) entries.set(r.entry.id, r.entry);
        if (r.bill) books.set(r.bill.id, r.bill);
      }
      // only this period's own results move this period's return; carried ones are shown, not applied
      const own = ws.rows.filter((r) => !r.carried).map((r) => r.match);
      const list = adjustmentsFor(own, entries, books);
      await this.gstr.replaceAdjustments(c, period.fp, 'reconcile', list);
      return list;
    });
  }
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
