import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  businessInputSchema,
  computeDocument,
  documentInputSchema,
  eInvoiceV11Schema,
  eWayBillSchema,
  gstinSchema,
  gstr1Schema,
  gstr3bSchema,
  itemInputSchema,
  lineInputSchema,
  paiseSchema,
  panSchema,
  partyInputSchema,
  type LineInput,
} from '../src';

describe('schemas', () => {
  it('validates GSTIN and PAN', () => {
    expect(gstinSchema.parse(' 27aapfu0939f1zv ')).toBe('27AAPFU0939F1ZV');
    expect(gstinSchema.safeParse('27AAPFU0939F1ZX').success).toBe(false);
    expect(panSchema.parse('aapfu0939f')).toBe('AAPFU0939F');
    expect(panSchema.safeParse('123').success).toBe(false);
  });

  it('coerces paise from number, string or bigint', () => {
    expect(paiseSchema.parse(5)).toBe(5n);
    expect(paiseSchema.parse('7')).toBe(7n);
    expect(paiseSchema.parse(9n)).toBe(9n);
    expect(paiseSchema.safeParse(1.5).success).toBe(false);
    expect(paiseSchema.safeParse('1.5').success).toBe(false);
  });

  it('validates a business', () => {
    const b = businessInputSchema.parse({
      legalName: 'Demo',
      stateCode: '27',
      gstin: '27AAPFU0939F1ZV',
    });
    expect(b.scheme).toBe('regular');
    expect(b.fyStartMonth).toBe(4);
    expect(businessInputSchema.safeParse({ legalName: 'x', stateCode: '25' }).success).toBe(false);
  });

  it('rejects an unregistered party with a GSTIN', () => {
    expect(
      partyInputSchema.safeParse({
        type: 'customer',
        name: 'A',
        isUnregistered: true,
        gstin: '27AAPFU0939F1ZV',
      }).success,
    ).toBe(false);
    expect(partyInputSchema.parse({ type: 'customer', name: 'A' }).creditDays).toBe(0);
  });

  it('validates items and lines', () => {
    expect(itemInputSchema.parse({ name: 'Wire', hsn: '7408' }).saleRatePaise).toBe(0n);
    expect(itemInputSchema.safeParse({ name: 'Wire', hsn: '74' }).success).toBe(false);
    expect(lineInputSchema.safeParse({ qtyMicros: 0, ratePaise: 1, gstRateBp: 0 }).success).toBe(
      false,
    );
    const l = lineInputSchema.parse({ qtyMicros: 1_000_000, ratePaise: '100', gstRateBp: 1800 });
    expect(l.qtyMicros).toBe(1_000_000n);
    expect(l.discount).toEqual({ mode: 'none' });
  });

  it('validates documents', () => {
    const base = {
      type: 'tax_invoice',
      date: '2026-04-01',
      placeOfSupply: '27',
      lines: [{ qtyMicros: 1_000_000, ratePaise: 100, gstRateBp: 1800 }],
    };
    expect(documentInputSchema.safeParse(base).success).toBe(true);
    expect(documentInputSchema.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(documentInputSchema.safeParse({ ...base, dueDate: '2026-03-01' }).success).toBe(false);
    expect(documentInputSchema.safeParse({ ...base, date: '1-4-26' }).success).toBe(false);
  });

  it('accepts placeholders for later phases', () => {
    for (const s of [gstr1Schema, gstr3bSchema, eInvoiceV11Schema, eWayBillSchema]) {
      expect(s.safeParse({ any: 'thing' }).success).toBe(true);
    }
  });
});

describe('performance', () => {
  it('computes a 500-line document in under 20 ms', () => {
    const lines: LineInput[] = Array.from({ length: 500 }, (_, i) => ({
      qtyMicros: BigInt(1 + (i % 7)) * 1_000_000n,
      ratePaise: BigInt(10_000 + i * 37),
      discount: i % 3 === 0 ? { mode: 'percent', bp: 500 } : { mode: 'none' },
      gstRateBp: [500, 1200, 1800, 2800][i % 4]!,
      cessBp: i % 10 === 0 ? 100 : 0,
    }));
    const run = () =>
      computeDocument(lines, {
        supply: 'intra',
        supplierState: '27',
        invoiceDiscount: { mode: 'percent', bp: 250 },
        roundOff: 'nearest_rupee',
      });
    for (let i = 0; i < 5; i++) run(); // warm up the JIT
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      run();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    expect(median).toBeLessThan(20);
  });
});

describe('no floating point on money', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  const files = walk(join(import.meta.dirname, '..', 'src')).filter((f) => !f.endsWith('.test.ts'));

  it('never converts paise to Number or uses Math rounding on them', () => {
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((text, i) => {
          if (/Number\([^)]*[pP]aise/.test(text)) bad.push(`${f}:${i + 1} ${text.trim()}`);
          if (/Math\.(round|floor|ceil|trunc)\([^)]*[pP]aise/.test(text))
            bad.push(`${f}:${i + 1} ${text.trim()}`);
          if (/parseFloat|toFixed/.test(text)) bad.push(`${f}:${i + 1} ${text.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
