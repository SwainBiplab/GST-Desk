import {
  monthPeriod,
  parse2bJson,
  periodOf,
  toDecimalString,
  type BookBill,
  type GstrPeriod,
} from '@gst/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { execRaw, type Database } from '../database';
import { seedDemo } from '../seed';
import { DIALECTS, openTestDb } from '../testing/harness';

import { runInTx, type Ctx } from './base';
import { GstrRepo } from './gstr';
import { Gstr2bRepo, entryRefKey, type ReconRow } from './gstr2b';

const opened: Database[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

const rupees = (p: number) => Number(toDecimalString(BigInt(p), 2));
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** A GSTR-2B JSON in the portal's layout for these supplier lines. */
function file(
  gstin: string,
  period: string,
  lines: { b: BookBill; number?: string; taxable?: number; itc?: 'Y' | 'N'; name?: string }[],
  extra: object[] = [],
) {
  const bySupplier = new Map<string, object[]>();
  const push = (g: string, inv: object) =>
    (bySupplier.get(g) ?? bySupplier.set(g, []).get(g)!).push(inv);
  for (const l of lines) {
    const taxable = l.taxable ?? l.b.taxable;
    push(l.b.supplierGstin, {
      inum: l.number ?? l.b.number,
      dt: ddmmyyyy(l.b.date),
      itcavl: l.itc ?? 'Y',
      txval: rupees(taxable),
      igst: rupees(l.b.igst),
      cgst: rupees(l.b.cgst),
      sgst: rupees(l.b.sgst),
      cess: rupees(l.b.cess),
    });
  }
  for (const e of extra as { gstin: string; inv: object }[]) push(e.gstin, e.inv);
  return JSON.stringify({
    data: {
      gstin,
      rtnprd: period,
      docdata: {
        b2b: [...bySupplier.entries()].map(([ctin, inv]) => ({ ctin, trdnm: 'Supplier', inv })),
      },
    },
  });
}

describe.each(DIALECTS)('GSTR-2B reconciliation on the seeded book (%s)', (dialect) => {
  let d: Database;
  let ctx: Ctx;
  let repo: Gstr2bRepo;
  let gstr: GstrRepo;
  let gstin: string;
  let period: GstrPeriod;
  let books: BookBill[];

  beforeAll(async () => {
    d = await openTestDb(dialect);
    opened.push(d);
    ({ ctx } = await seedDemo(d, { documents: 400, parties: 30, items: 60 }));
    repo = new Gstr2bRepo(d);
    gstr = new GstrRepo(d);
    gstin = (await gstr.businessInfo(ctx)).gstin;
    const all = await repo.loadBooks(ctx, '2024-04-01', '2026-03-31');
    // the month with the most purchase bills from suppliers with a GSTIN
    const byMonth = new Map<string, BookBill[]>();
    for (const b of all) {
      const fp = periodOf(gstin, b.date).fp;
      (byMonth.get(fp) ?? byMonth.set(fp, []).get(fp)!).push(b);
    }
    const [fp, list] = [...byMonth.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
    period = monthPeriod(gstin, Number(fp.slice(2)), Number(fp.slice(0, 2)));
    books = list;
  }, 120_000);

  const classOf = (rows: ReconRow[], billId: string) =>
    rows.find((r) => r.bill?.id === billId)?.match.cls;

  async function importPlanted(extraOnly2b = true) {
    const [exact, renumbered, differs, missing] = books;
    const json = file(
      gstin,
      period.fp,
      [
        { b: exact! },
        { b: renumbered!, number: `2025-26/${renumbered!.number}` },
        { b: differs!, taxable: differs!.taxable + 50_000 },
      ],
      extraOnly2b
        ? [
            {
              gstin: '29AABCU9603R1ZJ',
              inv: {
                inum: 'ONLY-2B-1',
                dt: ddmmyyyy(period.from),
                itcavl: 'Y',
                txval: 1000,
                cgst: 90,
                sgst: 90,
              },
            },
          ]
        : [],
    );
    const res = await repo.importReturn(ctx, parse2bJson(json), { source: 'json' });
    return {
      res,
      planted: { exact: exact!, renumbered: renumbered!, differs: differs!, missing: missing! },
    };
  }

  it('the seeded month has enough purchase bills to plant mismatches in', () => {
    expect(books.length).toBeGreaterThanOrEqual(4);
  });

  it('classifies a planted period: matched, matched with differences, in 2B only, in books only', async () => {
    const { res, planted } = await importPlanted();
    expect(res.count).toBe(4);
    const ws = await repo.workspace(ctx, period);
    expect(ws.hasImport).toBe(true);
    expect(classOf(ws.rows, planted.exact.id)).toBe('matched');
    const renumbered = ws.rows.find((r) => r.bill?.id === planted.renumbered.id)!;
    expect(renumbered.match.cls).toBe('matched_with_differences');
    expect(renumbered.match.diffs).toContain('number');
    expect(renumbered.match.fuzzy).toBe(true);
    const differs = ws.rows.find((r) => r.bill?.id === planted.differs.id)!;
    expect(differs.match.cls).toBe('matched_with_differences');
    expect(differs.match.diffs).toContain('taxable');
    expect(differs.explanation.key).toBe('differs');
    expect(classOf(ws.rows, planted.missing.id)).toBe('in_books_not_in_2b');
    const only2b = ws.rows.find((r) => r.entry?.number === 'ONLY-2B-1')!;
    expect(only2b.match.cls).toBe('in_2b_not_in_books');
    expect(only2b.explanation.key).toBe('only2b');
    // the tiles
    expect(ws.summary.counts.in_2b_not_in_books).toBe(1);
    expect(ws.summary.counts.matched).toBeGreaterThanOrEqual(1);
    expect(ws.summary.only2b.cgst + ws.summary.only2b.sgst).toBe(18_000);
  });

  it('gives the same classification when the same file is imported again, and replaces the period', async () => {
    const sig = (rows: ReconRow[]) =>
      rows
        .map(
          (r) =>
            `${r.match.cls}|${r.entry?.number ?? ''}|${r.bill?.id ?? ''}|${r.match.diffs.join(',')}`,
        )
        .join('\n');
    const before = await repo.workspace(ctx, period);
    await importPlanted();
    const after = await repo.workspace(ctx, period);
    expect(sig(after.rows)).toBe(sig(before.rows));
    const imports = (await repo.listImports(ctx)).filter((i) => i.period === period.fp);
    expect(imports).toHaveLength(1);
    expect(after.rows.filter((r) => r.entry?.number === 'ONLY-2B-1')).toHaveLength(1);
  });

  it('keeps a decision across a re-import, and a hand link turns an unmatched pair into a match', async () => {
    const { planted } = await importPlanted();
    const ws = await repo.workspace(ctx, period);
    const only2b = ws.rows.find((r) => r.entry?.number === 'ONLY-2B-1')!;
    // link the stray 2B line to the bill that was left out of the 2B
    await repo.decide(ctx, period.fp, only2b.decisionRef, 'link', {
      linkedDocumentId: planted.missing.id,
      note: 'the supplier wrote another number',
    });
    const linked = await repo.workspace(ctx, period);
    const row = linked.rows.find((r) => r.bill?.id === planted.missing.id)!;
    expect(row.entry?.number).toBe('ONLY-2B-1');
    expect(['matched', 'matched_with_differences']).toContain(row.match.cls);
    expect(
      linked.rows.some(
        (r) => r.match.cls === 'in_2b_not_in_books' && r.entry?.number === 'ONLY-2B-1',
      ),
    ).toBe(false);

    // import the period again: the decision is still there
    await importPlanted();
    const again = await repo.workspace(ctx, period);
    expect(again.rows.find((r) => r.bill?.id === planted.missing.id)?.entry?.number).toBe(
      'ONLY-2B-1',
    );

    await repo.clearDecision(ctx, only2b.decisionRef);
    const cleared = await repo.workspace(ctx, period);
    expect(classOf(cleared.rows, planted.missing.id)).toBe('in_books_not_in_2b');
  });

  it('ignores a line on request, accepts exact matches in bulk, and marks a bill as supplier to file', async () => {
    const { planted } = await importPlanted();
    const ws = await repo.workspace(ctx, period);
    const accepted = await repo.acceptMatches(ctx, period);
    expect(accepted).toBeGreaterThanOrEqual(1);
    const after = await repo.workspace(ctx, period);
    expect(after.rows.find((r) => r.bill?.id === planted.exact.id)?.decision?.decision).toBe(
      'accept',
    );
    expect(await repo.acceptMatches(ctx, period)).toBe(0);

    const missing = after.rows.find((r) => r.bill?.id === planted.missing.id)!;
    await repo.decide(ctx, period.fp, missing.decisionRef, 'supplier_to_file', {
      note: 'chased on call',
    });
    expect(
      (await repo.workspace(ctx, period)).rows.find((r) => r.bill?.id === planted.missing.id)
        ?.decision,
    ).toMatchObject({
      decision: 'supplier_to_file',
      note: 'chased on call',
    });

    const only2b = ws.rows.find((r) => r.entry?.number === 'ONLY-2B-1')!;
    await repo.decide(ctx, period.fp, only2b.decisionRef, 'ignore');
    expect(
      (await repo.workspace(ctx, period)).rows.some((r) => r.entry?.number === 'ONLY-2B-1'),
    ).toBe(false);
    await repo.clearDecision(ctx, only2b.decisionRef);
    await repo.clearDecision(ctx, missing.decisionRef);
  });

  it('applies the outcome to GSTR-3B table 4, replacing it each time', async () => {
    const { planted } = await importPlanted();
    const before = await gstr.review(ctx, period);
    const list = await repo.applyOutcomes(ctx, period);
    const deferred = list.find((a) => a.reason.includes('not shown by the supplier'))!;
    expect(deferred).toBeDefined();
    expect(deferred.iamt + deferred.camt + deferred.samt).toBe(
      -(planted.missing.igst + planted.missing.cgst + planted.missing.sgst),
    );
    const credit = (r: typeof before) => {
      const x = r.gstr3b.s4.net;
      return x.iamt + x.camt + x.samt + x.csamt;
    };
    const after = await gstr.review(ctx, period);
    // the missing bill's own tax is no longer claimed (when the bill is dated in this period's return)
    expect(credit(after)).toBeLessThanOrEqual(credit(before));
    expect((await gstr.listAdjustments(ctx, period.fp)).length).toBe(list.length);

    // applying again does not stack the same reductions
    await repo.applyOutcomes(ctx, period);
    const twice = await gstr.review(ctx, period);
    expect(twice.gstr3b.s4.net).toEqual(after.gstr3b.s4.net);
    expect((await gstr.listAdjustments(ctx, period.fp)).length).toBe(list.length);
  });

  it('carries an unmatched 2B line into the next month', async () => {
    await importPlanted();
    const next = periodOf(
      gstin,
      new Date(Date.parse(`${period.to}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10),
    );
    const ws = await repo.workspace(ctx, next);
    const carried = ws.rows.find((r) => r.entry?.number === 'ONLY-2B-1');
    expect(carried).toBeDefined();
    expect(carried!.carried).toBe(true);
    // a pair settled last month is history, not shown again
    expect(ws.rows.some((r) => r.match.cls === 'matched' && r.carried)).toBe(false);
  });

  it('refuses a file for another GSTIN, an empty file and a file whose month it cannot tell', async () => {
    const [a] = books;
    await expect(
      repo.importReturn(ctx, parse2bJson(file('27AAPFU0939F1ZV', period.fp, [{ b: a! }])), {
        source: 'json',
      }),
    ).rejects.toThrow(/is for GSTIN/);
    await expect(
      repo.importReturn(
        ctx,
        parse2bJson(JSON.stringify({ data: { gstin, rtnprd: period.fp, docdata: { b2b: [] } } })),
        { source: 'json' },
      ),
    ).rejects.toThrow();
    const noMonth = parse2bJson(file(gstin, '', [{ b: a! }]));
    await expect(repo.importReturn(ctx, noMonth, { source: 'json' })).rejects.toThrow(
      /which month/,
    );
    // the month can be chosen by hand
    const ok = await repo.importReturn(ctx, noMonth, { source: 'json', period: period.fp });
    expect(ok.period).toBe(period.fp);
  });

  it('keeps the matching tolerances as settings, refuses nonsense, and lets them change the result', async () => {
    const defaults = await repo.options(ctx);
    expect(defaults).toEqual({
      exactDateDays: 3,
      fuzzyDateDays: 45,
      amountTolerancePaise: 100,
      amountToleranceBp: 0,
    });
    for (const bad of [
      { ...defaults, exactDateDays: -1 },
      { ...defaults, exactDateDays: 1.5 },
      { ...defaults, fuzzyDateDays: 1_000 },
      { ...defaults, fuzzyDateDays: 1, exactDateDays: 5 },
      { ...defaults, amountToleranceBp: 5_000 },
      { ...defaults, amountTolerancePaise: -5 },
    ])
      await expect(repo.setOptions(ctx, bad)).rejects.toThrow();
    expect(await repo.options(ctx)).toEqual(defaults);

    // a 2B that is 50 paise off (rounding) in taxable value on one bill: inside the default tolerance, outside a strict one
    const [b] = books;
    const json = file(gstin, period.fp, [{ b: b!, taxable: b!.taxable + 50 }]);
    await repo.importReturn(ctx, parse2bJson(json), { source: 'json' });
    const loose = await repo.workspace(ctx, period);
    expect(classOf(loose.rows, b!.id)).toBe('matched');

    await repo.setOptions(ctx, { ...defaults, amountTolerancePaise: 0, amountToleranceBp: 0 });
    const strict = await repo.workspace(ctx, period);
    expect(strict.rows.find((r) => r.bill?.id === b!.id)?.match.diffs).toContain('taxable');
    expect(classOf(strict.rows, b!.id)).toBe('matched_with_differences');

    // an explicit option for one call still wins
    const override = await repo.workspace(ctx, period, { amountTolerancePaise: 1_000 });
    expect(classOf(override.rows, b!.id)).toBe('matched');
    await repo.setOptions(ctx, defaults);
  });

  it('names the decision key by supplier, comparable number and type', () => {
    expect(entryRefKey({ supplierGstin: 'abc', number: 'INV/0012', docType: 'invoice' })).toBe(
      'ABC|INV12|invoice',
    );
  });
});

describe.each(DIALECTS)('acknowledging pre-filing problems (%s)', (dialect) => {
  it('blocks until each problem is acknowledged with a reason, and acknowledgements can be taken back', async () => {
    const d = await openTestDb(dialect);
    opened.push(d);
    const { ctx } = await seedDemo(d, { documents: 200, parties: 20, items: 40 });
    const gstr = new GstrRepo(d);
    const gstin = (await gstr.businessInfo(ctx)).gstin;
    // the busiest month of the seed
    const docs = await gstr.loadDocs(ctx, '2024-04-01', '2026-03-31');
    const counts = new Map<string, number>();
    for (const x of docs) counts.set(x.date.slice(0, 7), (counts.get(x.date.slice(0, 7)) ?? 0) + 1);
    const ym = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const p = monthPeriod(gstin, Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));

    // plant a problem: an invoice marked intra-state with a place of supply that is not the business's state
    const victim = docs.find(
      (x) => x.type === 'tax_invoice' && x.status === 'issued' && x.date.startsWith(ym),
    )!;
    await runInTx(d, ctx, (tx) =>
      execRaw(
        d,
        tx,
        `UPDATE documents SET supply_type = 'intra', place_of_supply_state = '99' WHERE id = '${victim.id}'`,
      ),
    );

    const first = await gstr.review(ctx, p);
    expect(first.issues.some((i) => i.code === 'supply_type_pos_mismatch')).toBe(true);
    expect(first.blockers).toBe(first.issues.length);

    // exporting is refused while anything stands, whatever the screen thinks
    await expect(gstr.assertExportable(ctx, p)).rejects.toThrow(/must be fixed or acknowledged/);
    await expect(gstr.acknowledge(ctx, p.fp, first.issues[0]!.key!, '   ')).rejects.toThrow(
      /Say why/,
    );
    for (const i of first.issues) await gstr.acknowledge(ctx, p.fp, i.key!, 'known and accepted');
    const done = await gstr.review(ctx, p);
    expect(done.blockers).toBe(0);
    await expect(gstr.assertExportable(ctx, p)).resolves.toMatchObject({ blockers: 0 });
    expect(done.issues.every((i) => i.acknowledged === 'known and accepted')).toBe(true);

    // a changed reason replaces the old one; taking it back makes the problem block again
    await gstr.acknowledge(ctx, p.fp, first.issues[0]!.key!, 'a better reason');
    expect(
      (await gstr.review(ctx, p)).issues.find((i) => i.key === first.issues[0]!.key)?.acknowledged,
    ).toBe('a better reason');
    await gstr.unacknowledge(ctx, p.fp, first.issues[0]!.key!);
    const back = await gstr.review(ctx, p);
    expect(back.blockers).toBe(1);

    // another period is untouched
    const other = await gstr.listAcks(ctx, '012099');
    expect(other).toEqual([]);
  });
});
