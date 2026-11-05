import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  WRITE_OFF_MAX_PAISE,
  autoAllocate,
  balanceOfDocument,
  creditRemaining,
  overdueDays,
  payStatus,
  planCreditApplication,
  postPayment,
  postWriteOff,
  tcsOnReceipt,
  validateAllocations,
  type OpenDocument,
} from '../src';

const doc = (
  id: string,
  date: string,
  balance: bigint,
  dueDate: string | null = null,
): OpenDocument => ({ id, number: id, date, dueDate, balancePaise: balance });

describe('auto-allocation', () => {
  const docs = [
    doc('c', '2026-03-01', 300n, '2026-04-30'),
    doc('a', '2026-01-01', 100n, '2026-02-01'),
    doc('b', '2026-02-01', 200n, '2026-03-02'),
  ];

  it('fills the oldest due date first and carries the rest', () => {
    const r = autoAllocate(docs, 450n);
    expect(r.allocations).toEqual([
      { documentId: 'a', amountPaise: 100n },
      { documentId: 'b', amountPaise: 200n },
      { documentId: 'c', amountPaise: 150n },
    ]);
    expect(r.remainderPaise).toBe(0n);
  });

  it('leaves an overpayment as a remainder', () => {
    const r = autoAllocate(docs, 1000n);
    expect(r.allocations.reduce((n, a) => n + a.amountPaise, 0n)).toBe(600n);
    expect(r.remainderPaise).toBe(400n);
  });

  it('skips settled documents, falls back to the date, and breaks ties by number', () => {
    const r = autoAllocate(
      [
        doc('INV-10', '2026-01-01', 50n),
        doc('INV-9', '2026-01-01', 50n),
        doc('z', '2025-12-01', 0n),
      ],
      60n,
    );
    expect(r.allocations.map((a) => a.documentId)).toEqual(['INV-9', 'INV-10']);
    expect(r.allocations.map((a) => a.amountPaise)).toEqual([50n, 10n]);
  });

  it('never allocates more than any balance or more than the amount (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 12 }),
        fc.integer({ min: 0, max: 500_000 }),
        (balances, amount) => {
          const open = balances.map((b, i) =>
            doc(`d${i}`, `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, BigInt(b)),
          );
          const r = autoAllocate(open, BigInt(amount));
          const used = r.allocations.reduce((n, a) => n + a.amountPaise, 0n);
          expect(used + r.remainderPaise).toBe(BigInt(amount));
          for (const a of r.allocations) {
            expect(a.amountPaise).toBeGreaterThan(0n);
            expect(a.amountPaise <= open.find((d) => d.id === a.documentId)!.balancePaise).toBe(
              true,
            );
          }
        },
      ),
    );
  });
});

describe('document status', () => {
  const s = (total: bigint, paid = 0n, credit = 0n, wo = 0n) => ({
    totalPaise: total,
    paidPaise: paid,
    creditAppliedPaise: credit,
    writtenOffPaise: wo,
  });

  it('is unpaid, partial, paid or overpaid, from what has been settled', () => {
    expect(payStatus(s(1000n))).toBe('unpaid');
    expect(payStatus(s(1000n, 400n))).toBe('partial');
    expect(payStatus(s(1000n, 1000n))).toBe('paid');
    expect(payStatus(s(1000n, 600n, 400n))).toBe('paid');
    expect(payStatus(s(1000n, 990n, 0n, 10n))).toBe('paid');
    expect(payStatus(s(1000n, 1200n))).toBe('overpaid');
    expect(balanceOfDocument(s(1000n, 1200n))).toBe(-200n);
  });

  it('counts overdue days only while something is owed', () => {
    expect(overdueDays('2026-04-01', '2026-04-11', 100n)).toBe(10);
    expect(overdueDays('2026-04-01', '2026-04-01', 100n)).toBe(0);
    expect(overdueDays('2026-04-01', '2026-05-01', 0n)).toBe(0);
    expect(overdueDays(null, '2026-05-01', 100n)).toBe(0);
    expect(overdueDays('2026-02-28', '2026-03-01', 1n)).toBe(1);
  });
});

describe('allocation rules', () => {
  const balances = new Map([
    ['a', 1000n],
    ['b', 50n],
  ]);

  it('accepts allocations within the balances and the amount', () => {
    expect(
      validateAllocations({
        considerationPaise: 1050n,
        allocations: [
          { documentId: 'a', amountPaise: 1000n },
          { documentId: 'b', amountPaise: 50n },
        ],
        balances,
      }),
    ).toEqual([]);
  });

  it('refuses more than a balance, more than the amount, and unknown or repeated documents', () => {
    const e = validateAllocations({
      considerationPaise: 500n,
      allocations: [
        { documentId: 'a', amountPaise: 1001n },
        { documentId: 'x', amountPaise: 1n },
        { documentId: 'a', amountPaise: 1n },
      ],
      balances,
    });
    expect(e.join('|')).toMatch(/more than what is owed/);
    expect(e.join('|')).toMatch(/not open for this party/);
    expect(e.join('|')).toMatch(/allocated twice/);
    expect(e.join('|')).toMatch(/more than the amount received/);
  });

  it('allows a write-off of up to 99 paise only when it closes the document', () => {
    expect(
      validateAllocations({
        considerationPaise: 1000n,
        allocations: [{ documentId: 'a', amountPaise: 1000n, writeOffPaise: 99n }],
        balances: new Map([['a', 1099n]]),
      }),
    ).toEqual([]);
    expect(WRITE_OFF_MAX_PAISE).toBe(99n);
    // one paise too many
    expect(
      validateAllocations({
        considerationPaise: 1000n,
        allocations: [{ documentId: 'a', amountPaise: 1000n, writeOffPaise: 100n }],
        balances: new Map([['a', 1100n]]),
      }).join('|'),
    ).toMatch(/up to 99 paise/);
    // does not close the document
    expect(
      validateAllocations({
        considerationPaise: 1000n,
        allocations: [{ documentId: 'a', amountPaise: 900n, writeOffPaise: 50n }],
        balances: new Map([['a', 1100n]]),
      }).join('|'),
    ).toMatch(/close the document/);
  });
});

describe('TCS on receipt', () => {
  const base = { rateBp: 10, date: '2024-06-15' };

  it('is nothing within the threshold', () => {
    expect(
      tcsOnReceipt({ ...base, considerationPaise: 10_000_000n, cumulativeBeforePaise: 0n })
        .tcsPaise,
    ).toBe(0n);
  });

  it('applies to the part of a receipt that crosses Rs 50 lakh', () => {
    // 49 lakh already, receives 3 lakh: only 2 lakh is above the threshold; 0.1% = Rs 200
    const r = tcsOnReceipt({
      ...base,
      considerationPaise: 30_000_000n,
      cumulativeBeforePaise: 490_000_000n,
    });
    expect(r.tcsPaise).toBe(20_000n);
  });

  it('applies to the whole receipt once above the threshold', () => {
    expect(
      tcsOnReceipt({
        ...base,
        considerationPaise: 10_000_000n,
        cumulativeBeforePaise: 600_000_000n,
      }).tcsPaise,
    ).toBe(10_000n);
  });

  it('is zero from 1 April 2025 (Finance Act 2025) and when the buyer deducts TDS', () => {
    const big = {
      considerationPaise: 10_000_000n,
      cumulativeBeforePaise: 600_000_000n,
      rateBp: 10,
    };
    expect(tcsOnReceipt({ ...big, date: '2025-04-01' }).tcsPaise).toBe(0n);
    expect(tcsOnReceipt({ ...big, date: '2025-03-31' }).tcsPaise).toBe(10_000n);
    // the old (wrong) sunset of 1 Oct 2024 must still collect
    expect(tcsOnReceipt({ ...big, date: '2024-10-01' }).tcsPaise).toBe(10_000n);
    expect(tcsOnReceipt({ ...big, date: '2024-06-01', buyerDeductsTds: true }).tcsPaise).toBe(0n);
  });
});

describe('party credit', () => {
  it('carries what is left of a source forward', () => {
    expect(creditRemaining(1000n, 300n)).toBe(700n);
    expect(creditRemaining(1000n, 1000n)).toBe(0n);
    expect(creditRemaining(1000n, 1200n)).toBe(0n);
  });

  it('applies the oldest credit first, never beyond the balance or a source', () => {
    const plan = planCreditApplication(
      [
        { kind: 'document', id: 'cn2', date: '2026-02-01', label: 'CN-2', remainingPaise: 500n },
        { kind: 'payment', id: 'p1', date: '2026-01-01', label: 'RV-1', remainingPaise: 300n },
        { kind: 'payment', id: 'p0', date: '2025-12-01', label: 'RV-0', remainingPaise: 0n },
      ],
      700n,
    );
    expect(plan.map((p) => [p.source.id, p.amountPaise])).toEqual([
      ['p1', 300n],
      ['cn2', 400n],
    ]);
    expect(planCreditApplication([], 100n)).toEqual([]);
    expect(
      planCreditApplication(
        [{ kind: 'payment', id: 'p', date: '2026-01-01', label: 'RV', remainingPaise: 900n }],
        700n,
        250n,
      )[0]!.amountPaise,
    ).toBe(250n);
  });
});

describe('payment postings', () => {
  const total = (
    ls: { debitPaise: bigint; creditPaise: bigint }[],
    k: 'debitPaise' | 'creditPaise',
  ) => ls.reduce((n, l) => n + l[k], 0n);

  it('a cash receipt debits cash and credits receivables', () => {
    const ls = postPayment({ direction: 'received', mode: 'cash', amountPaise: 1000n });
    expect(ls.map((l) => [l.account, l.debitPaise, l.creditPaise])).toEqual([
      ['cash', 1000n, 0n],
      ['receivables', 0n, 1000n],
    ]);
  });

  it('TCS on a receipt goes to TCS payable and does not settle the customer', () => {
    const ls = postPayment({
      direction: 'received',
      mode: 'bank',
      amountPaise: 1001n,
      tcsPaise: 1n,
    });
    expect(ls.find((l) => l.account === 'receivables')!.creditPaise).toBe(1000n);
    expect(ls.find((l) => l.account === 'tcsPayable')!.creditPaise).toBe(1n);
    expect(total(ls, 'debitPaise')).toBe(total(ls, 'creditPaise'));
  });

  it('an adjustment moves no money and a payment made debits payables', () => {
    expect(
      postPayment({ direction: 'received', mode: 'adjustment', amountPaise: 5n })[0]!.account,
    ).toBe('adjustments');
    const ls = postPayment({ direction: 'made', mode: 'upi', amountPaise: 700n });
    expect(ls.map((l) => [l.account, l.debitPaise, l.creditPaise])).toEqual([
      ['payables', 700n, 0n],
      ['bank', 0n, 700n],
    ]);
  });

  it('refuses TCS on a payment made, or one that is not less than the amount', () => {
    expect(() =>
      postPayment({ direction: 'made', mode: 'bank', amountPaise: 10n, tcsPaise: 1n }),
    ).toThrow();
    expect(() =>
      postPayment({ direction: 'received', mode: 'bank', amountPaise: 10n, tcsPaise: 10n }),
    ).toThrow();
    expect(() => postPayment({ direction: 'received', mode: 'bank', amountPaise: 0n })).toThrow();
  });

  it('write-offs post to round-off on the right side', () => {
    expect(
      postWriteOff('received', 40n).map((l) => [l.account, l.debitPaise, l.creditPaise]),
    ).toEqual([
      ['roundOff', 40n, 0n],
      ['receivables', 0n, 40n],
    ]);
    expect(postWriteOff('made', 40n).map((l) => [l.account, l.debitPaise, l.creditPaise])).toEqual([
      ['payables', 40n, 0n],
      ['roundOff', 0n, 40n],
    ]);
  });
});
