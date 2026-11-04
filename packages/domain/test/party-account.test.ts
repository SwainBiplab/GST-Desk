import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  ageBucket,
  balanceOf,
  buildAgeing,
  buildStatement,
  daysBetween,
  docEffect,
  openingBalanceChange,
  postOpeningBalance,
  type AccountDoc,
  type AccountPayment,
  type PartyAccountInput,
} from '../src';

const doc = (
  over: Partial<AccountDoc> & Pick<AccountDoc, 'id' | 'type' | 'totalPaise'>,
): AccountDoc => ({
  number: over.id.toUpperCase(),
  date: '2026-01-10',
  dueDate: null,
  ...over,
});
const pay = (
  over: Partial<AccountPayment> & Pick<AccountPayment, 'id' | 'amountPaise'>,
): AccountPayment => ({
  date: '2026-01-20',
  direction: 'received',
  mode: 'upi',
  reference: null,
  ...over,
});
const acct = (over: Partial<PartyAccountInput> = {}): PartyAccountInput => ({
  openingPaise: 0n,
  openingDate: null,
  docs: [],
  payments: [],
  ...over,
});

describe('document effects', () => {
  it('raises what the party owes for sales and lowers it for credit notes and purchases', () => {
    expect(docEffect('tax_invoice')).toBe(1);
    expect(docEffect('bill_of_supply')).toBe(1);
    expect(docEffect('debit_note')).toBe(1);
    expect(docEffect('purchase_return')).toBe(1);
    expect(docEffect('credit_note')).toBe(-1);
    expect(docEffect('purchase_bill')).toBe(-1);
    expect(docEffect('expense')).toBe(-1);
    for (const t of ['quotation', 'proforma', 'delivery_challan', 'receipt_voucher'] as const) {
      expect(docEffect(t)).toBe(0);
    }
  });
});

describe('balance and statement', () => {
  const a = acct({
    openingPaise: 50_000n,
    openingDate: '2026-01-01',
    docs: [
      doc({ id: 'i1', type: 'tax_invoice', totalPaise: 118_000n, date: '2026-01-05' }),
      doc({ id: 'i2', type: 'tax_invoice', totalPaise: 59_000n, date: '2026-02-05' }),
      doc({ id: 'c1', type: 'credit_note', totalPaise: 11_800n, date: '2026-02-10' }),
      doc({ id: 'q1', type: 'quotation', totalPaise: 999_999n, date: '2026-02-11' }),
    ],
    payments: [pay({ id: 'p1', amountPaise: 100_000n, date: '2026-01-20' })],
  });

  it('nets opening, invoices, credit notes and payments; quotations do not count', () => {
    expect(balanceOf(a)).toBe(50_000n + 118_000n + 59_000n - 11_800n - 100_000n);
  });

  it('builds a running balance in date order that ends at the balance', () => {
    const s = buildStatement(a);
    expect(s.lines.map((l) => [l.kind, l.date, l.balancePaise])).toEqual([
      ['opening', '2026-01-01', 50_000n],
      ['document', '2026-01-05', 168_000n],
      ['payment', '2026-01-20', 68_000n],
      ['document', '2026-02-05', 127_000n],
      ['document', '2026-02-10', 115_200n],
    ]);
    expect(s.closingBalancePaise).toBe(balanceOf(a));
    expect(s.openingBalancePaise).toBe(0n);
    expect(s.lines[0]).toMatchObject({ debitPaise: 50_000n, creditPaise: 0n });
    expect(s.lines[2]).toMatchObject({ debitPaise: 0n, creditPaise: 100_000n });
  });

  it('puts documents before payments on the same day and orders ties by reference', () => {
    const s = buildStatement(
      acct({
        docs: [
          doc({ id: 'b', type: 'tax_invoice', totalPaise: 100n, date: '2026-03-01', number: 'B' }),
          doc({ id: 'a', type: 'tax_invoice', totalPaise: 200n, date: '2026-03-01', number: 'A' }),
        ],
        payments: [pay({ id: 'p', amountPaise: 50n, date: '2026-03-01' })],
      }),
    );
    expect(s.lines.map((l) => l.id)).toEqual(['a', 'b', 'p']);
  });

  it('folds earlier lines into the opening balance for a date range, inclusive at both ends', () => {
    const s = buildStatement(a, { from: '2026-01-20', to: '2026-02-05' });
    expect(s.openingBalancePaise).toBe(168_000n); // opening + first invoice
    expect(s.lines.map((l) => l.id)).toEqual(['p1', 'i2']);
    expect(s.lines[0]!.balancePaise).toBe(68_000n);
    expect(s.closingBalancePaise).toBe(127_000n);
    expect(buildStatement(a, { from: '2026-12-01' }).lines).toEqual([]);
    expect(buildStatement(a, { from: '2026-12-01' }).openingBalancePaise).toBe(balanceOf(a));
  });

  it('shows what we owe a supplier as a negative balance', () => {
    const s = acct({
      docs: [doc({ id: 'b1', type: 'purchase_bill', totalPaise: 80_000n })],
      payments: [pay({ id: 'p1', amountPaise: 30_000n, direction: 'made' })],
    });
    expect(balanceOf(s)).toBe(-50_000n);
    expect(buildStatement(s).lines.map((l) => [l.debitPaise, l.creditPaise])).toEqual([
      [0n, 80_000n],
      [30_000n, 0n],
    ]);
  });

  it('handles an opening balance with no date and a negative one', () => {
    const s = buildStatement(acct({ openingPaise: -700n }));
    expect(s.lines[0]).toMatchObject({ kind: 'opening', creditPaise: 700n, balancePaise: -700n });
    expect(buildStatement(acct()).lines).toEqual([]);
  });
});

describe('age buckets at the boundaries', () => {
  it.each([
    [-1, 'current'],
    [-30, 'current'],
    [0, 'd0_30'],
    [1, 'd0_30'],
    [30, 'd0_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd90plus'],
    [1000, 'd90plus'],
  ] as const)('%i days overdue is %s', (days, bucket) => expect(ageBucket(days)).toBe(bucket));

  it('counts calendar days across month ends and leap years', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetween('2025-02-28', '2025-03-01')).toBe(1);
    expect(daysBetween('2026-05-10', '2026-05-10')).toBe(0);
    expect(daysBetween('2026-05-10', '2026-05-01')).toBe(-9);
  });
});

describe('ageing', () => {
  const today = '2026-06-30';
  const inv = (id: string, total: bigint, due: string) =>
    doc({ id, type: 'tax_invoice', totalPaise: total, date: due, dueDate: due });

  it('puts each unpaid invoice in the bucket of its due date', () => {
    const g = buildAgeing(
      acct({
        docs: [
          inv('a', 100n, '2026-07-15'), // not due yet
          inv('b', 200n, '2026-06-30'), // due today
          inv('c', 300n, '2026-05-31'), // 30 days late
          inv('d', 400n, '2026-05-30'), // 31 days late
          inv('e', 500n, '2026-04-30'), // 61 days late
          inv('f', 600n, '2026-03-31'), // 91 days late
        ],
      }),
      today,
    );
    expect(g).toMatchObject({
      direction: 'receivable',
      current: 100n,
      d0_30: 500n,
      d31_60: 400n,
      d61_90: 500n,
      d90plus: 600n,
      totalDuePaise: 2100n,
      overduePaise: 2000n,
    });
  });

  it('applies payments and credit notes to the oldest charges first', () => {
    const g = buildAgeing(
      acct({
        docs: [
          inv('old', 1000n, '2026-03-01'),
          inv('new', 1000n, '2026-06-20'),
          doc({ id: 'cn', type: 'credit_note', totalPaise: 200n }),
        ],
        payments: [pay({ id: 'p', amountPaise: 900n })],
      }),
      today,
    );
    // 1100 of credit clears the old invoice (1000) and 100 of the new one
    expect(g).toMatchObject({ d90plus: 0n, d0_30: 900n, totalDuePaise: 900n });
  });

  it('turns an overpayment into an amount we owe them', () => {
    const g = buildAgeing(
      acct({
        docs: [inv('a', 500n, '2026-06-01')],
        payments: [pay({ id: 'p', amountPaise: 800n })],
      }),
      today,
    );
    expect(g).toMatchObject({ direction: 'payable', totalDuePaise: 300n, d0_30: 300n });
  });

  it('ages an opening balance from its date and a payable side for suppliers', () => {
    const g = buildAgeing(acct({ openingPaise: 700n, openingDate: '2026-01-01' }), today);
    expect(g).toMatchObject({ d90plus: 700n, totalDuePaise: 700n });
    const p = buildAgeing(
      acct({
        docs: [
          doc({
            id: 'b',
            type: 'purchase_bill',
            totalPaise: 900n,
            date: '2026-05-01',
            dueDate: '2026-05-31',
          }),
        ],
      }),
      today,
    );
    expect(p).toMatchObject({ direction: 'payable', d0_30: 900n, totalDuePaise: 900n });
  });

  it('uses the document date when there is no due date', () => {
    const g = buildAgeing(
      acct({
        docs: [
          doc({ id: 'x', type: 'tax_invoice', totalPaise: 10n, date: '2026-06-01', dueDate: null }),
        ],
      }),
      today,
    );
    expect(g.d0_30).toBe(10n);
  });

  it('buckets always add up to the absolute balance', () => {
    const amount = fc.integer({ min: 1, max: 1_000_000 }).map(BigInt);
    const date = fc
      .integer({ min: 0, max: 400 })
      .map((d) => new Date(Date.UTC(2025, 5, 1 + d)).toISOString().slice(0, 10));
    const docArb = fc.record({
      id: fc.uuid(),
      number: fc.constant(null),
      type: fc.constantFrom(
        'tax_invoice',
        'bill_of_supply',
        'credit_note',
        'purchase_bill',
        'debit_note',
        'purchase_return',
        'quotation',
      ),
      date,
      dueDate: fc.option(date, { nil: null }),
      totalPaise: amount,
    }) as fc.Arbitrary<AccountDoc>;
    const payArb = fc.record({
      id: fc.uuid(),
      date,
      direction: fc.constantFrom('received', 'made'),
      amountPaise: amount,
      mode: fc.constant('cash'),
      reference: fc.constant(null),
    }) as fc.Arbitrary<AccountPayment>;
    fc.assert(
      fc.property(
        fc.integer({ min: -500_000, max: 500_000 }).map(BigInt),
        fc.array(docArb, { maxLength: 12 }),
        fc.array(payArb, { maxLength: 8 }),
        (openingPaise, docs, payments) => {
          const a = acct({ openingPaise, openingDate: '2025-04-01', docs, payments });
          const g = buildAgeing(a, '2026-06-30');
          const b = balanceOf(a);
          expect(g.totalDuePaise).toBe(b < 0n ? -b : b);
          expect(buildStatement(a).closingBalancePaise).toBe(b);
          expect(g.overduePaise).toBe(g.totalDuePaise - g.current);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('opening balance posting', () => {
  it('debits receivables when they owe us and credits payables when we owe them', () => {
    const owed = postOpeningBalance(12_500n, 'Sharma');
    expect(owed).toEqual([
      {
        account: 'receivables',
        debitPaise: 12_500n,
        creditPaise: 0n,
        narration: 'Opening balance: Sharma',
      },
      {
        account: 'openingEquity',
        debitPaise: 0n,
        creditPaise: 12_500n,
        narration: 'Opening balance: Sharma',
      },
    ]);
    const owing = postOpeningBalance(-900n);
    expect(owing.map((l) => [l.account, l.debitPaise, l.creditPaise])).toEqual([
      ['openingEquity', 900n, 0n],
      ['payables', 0n, 900n],
    ]);
    expect(postOpeningBalance(0n)).toEqual([]);
  });
});

describe('opening balance changes', () => {
  const net = (
    ls: { account: string; debitPaise: bigint; creditPaise: bigint }[],
    account: string,
  ) =>
    ls.filter((l) => l.account === account).reduce((a, l) => a + l.debitPaise - l.creditPaise, 0n);
  const balanced = (ls: { debitPaise: bigint; creditPaise: bigint }[]) =>
    ls.reduce((a, l) => a + l.debitPaise - l.creditPaise, 0n) === 0n;

  it('posts only the difference when they owe us more or less', () => {
    const up = openingBalanceChange(50_000n, 80_000n);
    expect(up).toHaveLength(2);
    expect(net(up, 'receivables')).toBe(30_000n);
    const down = openingBalanceChange(80_000n, 50_000n);
    expect(net(down, 'receivables')).toBe(-30_000n);
    expect(balanced(up) && balanced(down)).toBe(true);
  });

  it('adjusts payables when we owe more or less', () => {
    expect(net(openingBalanceChange(-500n, -900n), 'payables')).toBe(-400n); // credit payables
    expect(net(openingBalanceChange(-900n, -500n), 'payables')).toBe(400n);
  });

  it('reverses and re-posts when the side changes or the balance goes to or from zero', () => {
    const flipSide = openingBalanceChange(1_000n, -700n);
    expect(net(flipSide, 'receivables')).toBe(-1_000n);
    expect(net(flipSide, 'payables')).toBe(-700n);
    expect(balanced(flipSide)).toBe(true);
    expect(net(openingBalanceChange(1_000n, 0n), 'receivables')).toBe(-1_000n);
    expect(net(openingBalanceChange(0n, -300n), 'payables')).toBe(-300n);
    expect(openingBalanceChange(5n, 5n)).toEqual([]);
  });

  it('always ends with the same receivable and payable as a fresh posting', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9000, max: 9000 }),
        fc.integer({ min: -9000, max: 9000 }),
        (a, b) => {
          const lines = [
            ...postOpeningBalance(BigInt(a)),
            ...openingBalanceChange(BigInt(a), BigInt(b)),
          ];
          const fresh = postOpeningBalance(BigInt(b));
          expect(net(lines, 'receivables')).toBe(net(fresh, 'receivables'));
          expect(net(lines, 'payables')).toBe(net(fresh, 'payables'));
          expect(balanced(lines)).toBe(true);
        },
      ),
    );
  });
});
