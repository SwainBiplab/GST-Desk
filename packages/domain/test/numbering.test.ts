import { describe, expect, it } from 'vitest';

import {
  NumberingError,
  consume,
  formatDocumentNumber,
  needsReset,
  release,
  remaining,
  renderAffix,
  reserve,
  takeNext,
  validateDocumentNumber,
  type Pool,
  type SeriesSpec,
} from '../src';

const spec: SeriesSpec = { prefix: 'INV/{FY}/', suffix: '', padding: 4, reset: 'fy' };

describe('formatting and validation', () => {
  it('renders tokens', () => {
    expect(renderAffix('{FY}-{YYYY}-{MM}', '2026-04-09')).toBe('26-27-2026-04');
    expect(formatDocumentNumber(spec, 7, '2026-03-31')).toBe('INV/25-26/0007');
    expect(formatDocumentNumber({ ...spec, prefix: 'A', suffix: '-{MM}' }, 12, '2026-11-02')).toBe(
      'A0012-11',
    );
  });

  it('enforces the 16 character limit and allowed characters', () => {
    expect(validateDocumentNumber('INV/25-26/0007')).toEqual([]);
    expect(validateDocumentNumber('')).toHaveLength(1);
    expect(validateDocumentNumber('A'.repeat(17))[0]).toMatch(/17 characters/);
    expect(validateDocumentNumber('INV 001')[0]).toMatch(/only/);
    expect(validateDocumentNumber('INV_001')[0]).toMatch(/only/);
    expect(() =>
      formatDocumentNumber({ ...spec, prefix: 'INVOICE/{FY}/' }, 1, '2026-04-01'),
    ).toThrow(NumberingError);
  });

  it('handles padding overflow without truncating', () => {
    expect(formatDocumentNumber(spec, 12345, '2026-04-01')).toBe('INV/26-27/12345');
    expect(() => formatDocumentNumber(spec, 1_234_567, '2026-04-01')).toThrow(/limit/);
  });

  it('rejects non-positive or fractional numbers', () => {
    expect(() => formatDocumentNumber(spec, 0, '2026-04-01')).toThrow(NumberingError);
    expect(() => formatDocumentNumber(spec, 1.5, '2026-04-01')).toThrow(NumberingError);
  });
});

describe('financial-year reset', () => {
  it('restarts at 1 on 1 April', () => {
    let state = { next: 1, fy: null as string | null };
    let n: string;
    ({ number: n, state } = takeNext(spec, state, '2026-03-30'));
    expect(n).toBe('INV/25-26/0001');
    ({ number: n, state } = takeNext(spec, state, '2026-03-31'));
    expect(n).toBe('INV/25-26/0002');
    expect(needsReset(spec, state, '2026-04-01')).toBe(true);
    ({ number: n, state } = takeNext(spec, state, '2026-04-01'));
    expect(n).toBe('INV/26-27/0001');
    expect(state).toEqual({ next: 2, fy: '26-27' });
  });

  it('never resets when configured so', () => {
    const never: SeriesSpec = { prefix: 'INV-', suffix: '', padding: 5, reset: 'never' };
    let state = { next: 41, fy: null as string | null };
    ({ state } = takeNext(never, state, '2026-03-31'));
    const r = takeNext(never, state, '2026-04-01');
    expect(r.number).toBe('INV-00042');
    expect(needsReset(never, state, '2030-01-01')).toBe(false);
  });
});

describe('multi-device reservations', () => {
  const pool0: Pool = { next: 1, released: [] };

  it('hands out disjoint consecutive ranges', () => {
    const a = reserve(pool0, 10);
    const b = reserve(a.pool, 5);
    expect(a.reservation).toEqual({ from: 1, to: 10, used: 0 });
    expect(b.reservation).toEqual({ from: 11, to: 15, used: 0 });
    expect(b.pool.next).toBe(16);
  });

  it('consumes in order and fails when exhausted', () => {
    let r = reserve(pool0, 2).reservation;
    const first = consume(r);
    expect(first.number).toBe(1);
    r = first.reservation;
    const second = consume(r);
    expect(second.number).toBe(2);
    expect(remaining(second.reservation)).toBe(0);
    expect(() => consume(second.reservation)).toThrow(/exhausted/);
  });

  it('releases unused numbers back and reuses them first', () => {
    const a = reserve(pool0, 10);
    const b = reserve(a.pool, 10); // 11-20
    // device A used 3 of 10, then released the rest while B still holds 11-20
    const usedA = { ...a.reservation, used: 3 };
    const afterRelease = release(b.pool, usedA);
    expect(afterRelease.released).toEqual([{ from: 4, to: 10 }]);
    const c = reserve(afterRelease, 5);
    expect(c.reservation).toMatchObject({ from: 4, to: 8 });
    const d = reserve(c.pool, 3); // exactly 9-10 remain (2) so this needs fresh numbers
    expect(d.reservation).toMatchObject({ from: 21, to: 23 });
    const e = reserve(d.pool, 2);
    expect(e.reservation).toMatchObject({ from: 9, to: 10 });
    expect(e.pool.released).toEqual([]);
  });

  it('shrinks the pool when the released range is at the tail', () => {
    const a = reserve(pool0, 10);
    const back = release(a.pool, { ...a.reservation, used: 4 });
    expect(back).toEqual({ next: 5, released: [] });
  });

  it('ignores fully used reservations and rejects bad sizes', () => {
    const a = reserve(pool0, 2);
    const full = { ...a.reservation, used: 2 };
    expect(release(a.pool, full)).toBe(a.pool);
    expect(() => reserve(pool0, 0)).toThrow(NumberingError);
    expect(() => reserve(pool0, 1.5)).toThrow(NumberingError);
  });
});
