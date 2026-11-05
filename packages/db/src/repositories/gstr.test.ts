import { buildGstr1, periodsBetween, quarterPeriod, type GstrPeriod } from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { type Ctx } from './base';
import { GstrRepo } from './gstr';
import { runReport } from './reports';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

describe.each(DIALECTS)('GST returns on the seeded book (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let repo: GstrRepo;
  let periods: GstrPeriod[];

  beforeAll(async () => {
    d = await openTestDb(dialect);
    opened.push(d);
    ({ ctx } = await seedDemo(d, { documents: 400, parties: 30, items: 60 }));
    repo = new GstrRepo(d);
    const info = await repo.businessInfo(ctx);
    periods = periodsBetween(info.gstin || '27AAPFU0939F1ZV', '2024-04-01', '2026-03-31');
  }, 120_000);

  it('GSTR-1 reconciles with the GST summary report to the paise, every month', async () => {
    let months = 0;
    for (const p of periods) {
      const docs = await repo.loadDocs(ctx, p.from, p.to);
      const g = buildGstr1(p, docs);
      const sum = await runReport(d, ctx, 'gst_summary', {
        from: p.from,
        to: p.to,
        today: p.to,
        type: 'outward',
      });
      const taxable = g.totals.txval + g.nilTotalPaise + g.unplacedPaise;
      expect(taxable, `taxable value, ${p.fp}`).toBe(sum.totals['taxable'] ?? 0);
      expect(g.totals.iamt, `IGST, ${p.fp}`).toBe(sum.totals['igst'] ?? 0);
      expect(g.totals.camt, `CGST, ${p.fp}`).toBe(sum.totals['cgst'] ?? 0);
      expect(g.totals.samt, `SGST, ${p.fp}`).toBe(sum.totals['sgst'] ?? 0);
      expect(g.totals.csamt, `cess, ${p.fp}`).toBe(sum.totals['cess'] ?? 0);
      if (docs.length > 0) months += 1;
    }
    expect(months).toBeGreaterThan(6);
  });

  it('the HSN tables reconcile with the HSN summary report', async () => {
    for (const p of periods) {
      const docs = await repo.loadDocs(ctx, p.from, p.to);
      const g = buildGstr1(p, docs);
      const hsn = await runReport(d, ctx, 'hsn_summary', { from: p.from, to: p.to, today: p.to });
      const mine = [...g.hsnB2b, ...g.hsnB2c].reduce((a, h) => a + h.txval, 0);
      expect(mine, `HSN taxable value, ${p.fp}`).toBe(hsn.totals['taxable'] ?? 0);
    }
  });

  it('a seeded month builds both returns with a consistent cross-check', async () => {
    let checked = 0;
    for (const p of periods) {
      const r = await repo.review(ctx, p);
      if (!r.hasDocuments) continue;
      checked += 1;
      const codes = r.issues.map((i) => i.code);
      expect(codes, p.fp).not.toContain('table_total_mismatch');
      expect(codes, p.fp).not.toContain('gstr1_3b_taxable_mismatch');
      expect(codes, p.fp).not.toContain('gstr1_3b_tax_mismatch');
      // every document that lands in a table is accounted for in table 13 (issued + cancelled)
      const issued = (await repo.loadDocs(ctx, p.from, p.to)).filter(
        (x) => x.status === 'issued' && ['tax_invoice', 'bill_of_supply'].includes(x.type),
      ).length;
      const inRange = r.gstr1.docs
        .filter((x) => x.docNum === 1)
        .reduce((a, x) => a + x.netIssue, 0);
      expect(inRange, `invoices in table 13, ${p.fp}`).toBe(issued);
    }
    expect(checked).toBeGreaterThan(6);
  });

  it('reads quarters too', async () => {
    const q = quarterPeriod('27AAPFU0939F1ZV', 2025, 6);
    const m = periods.filter((p) => p.from >= q.from && p.to <= q.to);
    const whole = await repo.loadDocs(ctx, q.from, q.to);
    let sum = 0;
    for (const p of m) sum += (await repo.loadDocs(ctx, p.from, p.to)).length;
    expect(whole.length).toBe(sum);
  });

  it('records exporting, filing and reopening, and refuses bad input', async () => {
    const p = periods[3]!;
    expect(await repo.listFilings(ctx)).toEqual([]);

    const ex = await repo.markExported(ctx, 'gstr1', p, 'v1');
    expect(ex).toMatchObject({ status: 'exported', schemaVersion: 'v1', returnType: 'gstr1' });
    expect(ex.exportedAt).toBeGreaterThan(0);
    // exporting again updates the same row
    await repo.markExported(ctx, 'gstr1', p, 'v1');
    expect(await repo.listFilings(ctx)).toHaveLength(1);

    await expect(
      repo.markFiled(ctx, 'gstr1', p, { arn: 'x', filedOn: '2030-01-01' }),
    ).rejects.toThrow(/ARN/);
    await expect(
      repo.markFiled(ctx, 'gstr1', p, { arn: 'AA270525123456Z', filedOn: p.from }),
    ).rejects.toThrow(/before its period has ended/);
    const filed = await repo.markFiled(ctx, 'gstr1', p, {
      arn: ' aa270525123456z ',
      filedOn: '2030-01-01',
    });
    expect(filed).toMatchObject({ status: 'filed', arn: 'AA270525123456Z', filedOn: '2030-01-01' });
    // an export after filing does not move it back
    expect((await repo.markExported(ctx, 'gstr1', p, 'v1')).status).toBe('filed');
    // the other return of the same period is independent
    expect((await repo.listFilings(ctx)).filter((f) => f.returnType === 'gstr3b')).toEqual([]);

    await expect(repo.reopen(ctx, 'gstr1', p, '  ')).rejects.toThrow(/why/);
    const re = await repo.reopen(ctx, 'gstr1', p, 'wrong month');
    expect(re).toMatchObject({ status: 'exported', arn: null, filedOn: null });
    await expect(repo.reopen(ctx, 'gstr1', p, 'again')).rejects.toThrow(/not marked as filed/);

    const due = await repo.setDueOverride(ctx, 'gstr3b', p, '2030-02-01');
    expect(due.dueOverride).toBe('2030-02-01');
    await expect(repo.setDueOverride(ctx, 'gstr3b', p, 'soon')).rejects.toThrow(/valid due date/);
  });

  it('keeps ITC adjustments with a reason and applies them to the return', async () => {
    const p = periods.find((x) => x.fp === '092024')!;
    const before = await repo.review(ctx, p);
    await expect(
      repo.addAdjustment(ctx, p.fp, {
        field: 'itc.nope',
        iamt: 0,
        camt: 1,
        samt: 1,
        csamt: 0,
        reason: 'x',
      }),
    ).rejects.toThrow(/does not exist/);
    await expect(
      repo.addAdjustment(ctx, p.fp, {
        field: 'itc.reversedOther',
        iamt: 0,
        camt: 1,
        samt: 1,
        csamt: 0,
        reason: ' ',
      }),
    ).rejects.toThrow(/Say why/);
    await expect(
      repo.addAdjustment(ctx, p.fp, {
        field: 'itc.reversedOther',
        iamt: 0.5,
        camt: 1,
        samt: 1,
        csamt: 0,
        reason: 'x',
      }),
    ).rejects.toThrow(/whole paise/);

    await repo.addAdjustment(ctx, p.fp, {
      field: 'itc.reversedOther',
      iamt: 0,
      camt: 5_000,
      samt: 5_000,
      csamt: 0,
      reason: 'blocked credit on a gift',
    });
    const after = await repo.review(ctx, p);
    expect(after.gstr3b.s4.reversedOther).toMatchObject({ camt: 5_000, samt: 5_000 });
    expect(after.gstr3b.s4.net.camt).toBe(before.gstr3b.s4.net.camt - 5_000);
    // another period is untouched
    const other = await repo.listAdjustments(ctx, '102024');
    expect(other).toEqual([]);

    const rows = await repo.listAdjustmentRows(ctx, p.fp);
    expect(rows).toHaveLength(1);
    await repo.removeAdjustment(ctx, rows[0]!.id, rows[0]!.version);
    const gone = await repo.review(ctx, p);
    expect(gone.gstr3b.s4.reversedOther).toMatchObject({ camt: 0, samt: 0 });
  });
});
