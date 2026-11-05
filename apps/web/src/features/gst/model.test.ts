import { monthPeriod, reviewPeriod, type GstrDoc, type GstrLine } from '@gst/domain';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  cardState,
  gstr1CsvZip,
  gstr1JsonFile,
  gstr1Rows,
  gstr3bJsonFile,
  periodLabel,
  recentPeriods,
} from './model';

const GSTIN = '27AAPFU0939F1ZV';

describe('recentPeriods', () => {
  it('lists the last twelve months, newest first, ending with the current one', () => {
    const ps = recentPeriods(GSTIN, '2026-04-05', 'month');
    expect(ps).toHaveLength(12);
    expect(ps[0]!.fp).toBe('042026');
    expect(ps[11]!.fp).toBe('052025');
    expect(new Set(ps.map((p) => p.fp)).size).toBe(12);
  });

  it('lists the last four quarters', () => {
    const ps = recentPeriods(GSTIN, '2026-04-05', 'quarter');
    expect(ps).toHaveLength(4);
    expect(ps[0]).toMatchObject({ fp: '062026', kind: 'quarter' });
  });
});

describe('periodLabel', () => {
  it('names a month and a quarter', () => {
    expect(periodLabel(monthPeriod(GSTIN, 2026, 3), 'en')).toBe('Mar 2026');
    const q = recentPeriods(GSTIN, '2026-04-05', 'quarter')[1]!;
    expect(periodLabel(q, 'en')).toBe('Jan – Mar 2026');
  });
});

describe('cardState', () => {
  const period = monthPeriod(GSTIN, 2026, 3);
  const base = { ret: 'gstr1' as const, period, stateCode: '27', filing: null };
  it('is ready with documents and no problems, not started otherwise', () => {
    expect(
      cardState({ ...base, review: { blockers: 0, hasDocuments: true }, today: '2026-04-05' })
        .status,
    ).toBe('ready');
    expect(
      cardState({ ...base, review: { blockers: 3, hasDocuments: true }, today: '2026-04-05' })
        .status,
    ).toBe('not_started');
    expect(cardState({ ...base, review: null, today: '2026-04-05' }).status).toBe('not_started');
  });
  it('turns late after the due date, and uses a due date the person set', () => {
    expect(
      cardState({ ...base, review: { blockers: 0, hasDocuments: true }, today: '2026-04-12' })
        .status,
    ).toBe('late');
    const filing = {
      returnType: 'gstr1',
      fp: period.fp,
      status: 'open',
      exportedAt: null,
      schemaVersion: null,
      arn: null,
      filedOn: null,
      dueOverride: '2026-04-30',
      id: 'f',
      version: 1,
    } as const;
    const s = cardState({
      ...base,
      filing,
      review: { blockers: 0, hasDocuments: true },
      today: '2026-04-12',
    });
    expect(s).toMatchObject({ status: 'ready', due: '2026-04-30', overridden: true });
  });
  it('stays filed after the due date', () => {
    const filing = {
      returnType: 'gstr1',
      fp: period.fp,
      status: 'filed',
      exportedAt: 1,
      schemaVersion: 'v1',
      arn: 'AA270326123456Z',
      filedOn: '2026-04-09',
      dueOverride: null,
      id: 'f',
      version: 2,
    } as const;
    expect(
      cardState({
        ...base,
        filing,
        review: { blockers: 5, hasDocuments: true },
        today: '2026-05-01',
      }).status,
    ).toBe('filed');
  });
});

describe('review tables and export files', () => {
  const line: GstrLine = {
    hsn: '6109',
    description: 'T-shirt',
    uqc: 'NOS',
    qtyMicros: 1_000_000,
    taxablePaise: 100_000,
    rateBp: 500,
    igstPaise: 0,
    cgstPaise: 2_500,
    sgstPaise: 2_500,
    cessPaise: 0,
    taxability: 'taxable',
  };
  const doc = (o: Partial<GstrDoc>): GstrDoc => ({
    id: 'd1',
    type: 'tax_invoice',
    status: 'issued',
    number: 'INV/1',
    seriesKey: 'inv',
    date: '2026-03-10',
    partyName: 'Buyer',
    partyGstin: '29AABCU9603R1ZJ',
    registered: true,
    partyComposition: false,
    partyState: '29',
    pos: '27',
    supplierState: '27',
    supplyType: 'intra',
    lut: false,
    reverseCharge: false,
    totalPaise: 105_000,
    linkedNumber: '',
    linkedDate: '',
    linkedTotalPaise: 0,
    lines: [line],
    ...o,
  });
  const review = reviewPeriod(
    monthPeriod(GSTIN, 2026, 3),
    [
      doc({}),
      doc({ id: 'd2', number: 'INV/2', registered: false, partyGstin: '' }),
      doc({
        id: 'd3',
        type: 'credit_note',
        number: 'CN/1',
        seriesKey: 'cn',
        totalPaise: 52_500,
        lines: [{ ...line, taxablePaise: 50_000, cgstPaise: 1_250, sgstPaise: 1_250 }],
      }),
    ],
    [],
    { gstin: GSTIN, scheme: 'regular', minHsnDigits: 4 },
  );

  it('summarises each GSTR-1 table, with credit notes as minus', () => {
    const rows = Object.fromEntries(gstr1Rows(review).map((r) => [r.key, r]));
    expect(rows['b2b']).toMatchObject({ count: 1, taxable: 100_000, tax: 5_000 });
    expect(rows['b2cs']).toMatchObject({ count: 1, taxable: 100_000 });
    expect(rows['cdnr']).toMatchObject({ count: 1, taxable: -50_000, tax: -2_500 });
    expect(rows['docs']).toMatchObject({ count: 3, taxable: null });
  });

  it('names and fills the export files', () => {
    const j = gstr1JsonFile(review);
    expect(j.name).toBe('GSTR1_27AAPFU0939F1ZV_032026.json');
    expect(JSON.parse(j.data as string).fp).toBe('032026');
    expect(gstr3bJsonFile(review).name).toBe('GSTR3B_27AAPFU0939F1ZV_032026.json');
  });

  it('puts only the tables that have rows in the CSV zip', () => {
    const z = gstr1CsvZip(review);
    expect(z.name).toBe('GSTR1_27AAPFU0939F1ZV_032026_csv.zip');
    const names = Object.keys(unzipSync(z.data as Uint8Array)).sort();
    expect(names).toEqual([
      'b2b.csv',
      'b2cs.csv',
      'cdnr.csv',
      'docs.csv',
      'hsn-b2b.csv',
      'hsn-b2c.csv',
    ]);
    const b2b = strFromU8(unzipSync(z.data as Uint8Array)['b2b.csv']!);
    expect(b2b).toContain('INV/1');
  });
});
