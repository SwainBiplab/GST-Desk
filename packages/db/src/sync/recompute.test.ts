import { emptyDraft, emptyDraftLine, draftToRows } from '@gst/domain';
import { describe, expect, it } from 'vitest';

import { recomputeErrors } from './recompute';

function sample() {
  const d = {
    ...emptyDraft('tax_invoice', '2026-06-01', { supplierState: '27', composition: false }),
    partyName: 'Asha',
    placeOfSupply: '29',
    lines: [
      {
        ...emptyDraftLine('a'),
        description: 'Pen',
        qtyMicros: 3_000_000n,
        ratePaise: 1000n,
        gstRateBp: 1800,
      },
      {
        ...emptyDraftLine('b'),
        description: 'Book',
        qtyMicros: 1_000_000n,
        ratePaise: 25000n,
        gstRateBp: 500,
        discountValue: 500n,
      },
    ],
    discountMode: 'percent' as const,
    roundOff: true,
  };
  const r = draftToRows(d);
  const doc: Record<string, unknown> = {
    ...(r.doc as unknown as Record<string, unknown>),
    id: 'd1',
  };
  const lines: Record<string, unknown>[] = r.lines.map((l, i) => ({
    ...(l as unknown as Record<string, unknown>),
    id: `l${i}`,
    deleted_at: null,
  }));
  return { doc, lines };
}

describe('recomputing an uploaded document', () => {
  it('agrees with what the engine made', () => {
    const { doc, lines } = sample();
    expect(recomputeErrors(doc, lines)).toEqual([]);
  });
  it('catches a changed total, a changed head of tax, a changed rate, and a dropped line', () => {
    const { doc, lines } = sample();
    expect(
      recomputeErrors({ ...doc, total_paise: Number(doc['total_paise']) - 100 }, lines)[0],
    ).toMatch(/total_paise/);
    const tampered = lines.map((l, i) =>
      i === 0 ? { ...l, igst_paise: Number(l['igst_paise']) + 1 } : l,
    );
    expect(recomputeErrors(doc, tampered).join(' ')).toMatch(/igst_paise/);
    const cheaper = lines.map((l, i) => (i === 0 ? { ...l, rate_paise: 900 } : l));
    expect(recomputeErrors(doc, cheaper).length).toBeGreaterThan(0);
    expect(recomputeErrors(doc, [lines[0]!]).length).toBeGreaterThan(0);
  });
});
