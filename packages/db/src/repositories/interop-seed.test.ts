import { buildTallyMasters, buildTallyVouchers, readTally } from '@gst/interop';
import { describe, expect, it } from 'vitest';

import { seedDemo } from '../seed';
import { openTestDb } from '../testing/harness';

import { InteropRepo } from './interop';

describe('the demo book through Tally (sqlite)', () => {
  it('exports, and the export reads back with no errors', async () => {
    const d = await openTestDb('sqlite');
    const { ctx } = await seedDemo(d, { documents: 120, parties: 12, items: 25 });
    const repo = new InteropRepo(d);
    const input = await repo.tallyInput(ctx, '2020-01-01', '2030-12-31');
    expect(input.documents.length).toBeGreaterThan(10);
    const masters = buildTallyMasters(input);
    const vouchers = buildTallyVouchers(input);
    expect(vouchers.warnings).toEqual([]);
    const bundle = readTally(masters.xml + vouchers.xml);
    expect(bundle.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(bundle.documents.length).toBe(input.documents.length);
    await d.close();
  }, 120_000);
});
