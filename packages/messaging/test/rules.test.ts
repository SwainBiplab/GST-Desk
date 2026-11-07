import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OFFSETS,
  DEFAULT_BODIES,
  KINDS,
  LANGUAGES,
  VARIABLES,
  afterQuiet,
  dueDates,
  dueReminders,
  firstRun,
  inQuietHours,
  istDate,
  istInstant,
  nextRun,
  renderPreview,
  renderSubject,
  reminderKey,
  resolveVariables,
  rupees,
  templateName,
  templateProblems,
  type ReminderDocument,
  type ReminderParty,
} from '../src';

const at = (date: string, hhmm: string) => istInstant(date, hhmm);
const doc = (over: Partial<ReminderDocument> = {}): ReminderDocument => ({
  id: 'd1',
  partyId: 'p1',
  type: 'tax_invoice',
  status: 'issued',
  number: 'INV/1',
  dueDate: '2026-11-10',
  outstandingPaise: 100_000n,
  ...over,
});
const parties = (over: Partial<ReminderParty> = {}) =>
  new Map([['p1', { id: 'p1', optedOut: false, reachable: true, ...over }]]);
const run = (
  now: number,
  d: ReminderDocument[],
  o: { made?: string[]; party?: Partial<ReminderParty>; offsets?: number[] } = {},
) =>
  dueReminders({
    now,
    documents: d,
    parties: parties(o.party),
    offsets: o.offsets ?? [...DEFAULT_OFFSETS],
    made: new Set(o.made ?? []),
  });

describe('reminder rules (vectors)', () => {
  const noon = (date: string) => at(date, '12:00');

  it.each([
    ['two days before the rule day: nothing', '2026-11-06', []],
    ['three days before the due date', '2026-11-07', [-3]],
    ['the day after that rule is still inside its grace', '2026-11-08', [-3]],
    ['two days after the first rule: its grace is over, the next is not due', '2026-11-10', [0]],
    ['seven days after the due date', '2026-11-17', [7]],
    ['between rules: nothing', '2026-11-13', []],
    ['fifteen days after', '2026-11-25', [15]],
    ['long after the last rule: nothing', '2026-12-30', []],
  ])('%s', (_name, today, offsets) => {
    expect(run(noon(today), [doc()]).due.map((d) => d.offset)).toEqual(offsets);
  });

  it('makes each reminder once', () => {
    const first = run(noon('2026-11-07'), [doc()]);
    expect(first.due).toHaveLength(1);
    expect(run(noon('2026-11-07'), [doc()], { made: [reminderKey('d1', -3)] }).due).toEqual([]);
    expect(
      run(noon('2026-11-10'), [doc()], { made: [reminderKey('d1', -3)] }).due.map((d) => d.offset),
    ).toEqual([0]);
  });

  it('sends only the latest of several rules that have come due, and passes the rest over', () => {
    // switched on after the due date: -3 and 0 are long past, 7 is due; offsets 0 and 1 together are both due on day 1
    const r = run(noon('2026-11-11'), [doc()], { offsets: [0, 1, 7] });
    expect(r.due.map((d) => d.offset)).toEqual([1]);
    expect(r.passed).toEqual([reminderKey('d1', 0)]);
  });

  it('never chases a cancelled document, a draft, a quotation, a paid one, a deleted one or one with no due date', () => {
    const now = noon('2026-11-10');
    for (const d of [
      doc({ status: 'cancelled' }),
      doc({ status: 'draft' }),
      doc({ type: 'quotation' }),
      doc({ type: 'purchase_bill' }),
      doc({ outstandingPaise: 0n }),
      doc({ deletedAt: 5 }),
      doc({ dueDate: null }),
      doc({ partyId: null }),
    ])
      expect(run(now, [d]).due).toEqual([]);
    expect(run(now, [doc()]).due).toHaveLength(1);
  });

  it('never sends to a party who opted out or cannot be reached', () => {
    const now = noon('2026-11-10');
    expect(run(now, [doc()], { party: { optedOut: true } }).due).toEqual([]);
    expect(run(now, [doc()], { party: { reachable: false } }).due).toEqual([]);
    expect(
      dueReminders({ now, documents: [doc()], parties: new Map(), offsets: [0], made: new Set() })
        .due,
    ).toEqual([]);
  });

  it('holds a reminder that falls in quiet hours until the morning', () => {
    const night = at('2026-11-10', '22:30');
    const r = run(night, [doc()]);
    expect(r.due).toHaveLength(1);
    expect(r.due[0]!.notBefore).toBe(at('2026-11-11', '09:00'));
    expect(run(noon('2026-11-10'), [doc()]).due[0]!.notBefore).toBe(noon('2026-11-10'));
  });

  it('reads the date in India, not in UTC', () => {
    // 20:00 UTC on 9 November is 01:30 IST on the 10th
    expect(istDate(Date.UTC(2026, 10, 9, 20, 0))).toBe('2026-11-10');
    expect(istDate(Date.UTC(2026, 10, 9, 18, 0))).toBe('2026-11-09');
  });
});

describe('quiet hours', () => {
  const q = { start: '21:00', end: '09:00' };
  it('covers a window across midnight', () => {
    expect(inQuietHours(at('2026-11-10', '21:00'), q)).toBe(true);
    expect(inQuietHours(at('2026-11-10', '03:00'), q)).toBe(true);
    expect(inQuietHours(at('2026-11-10', '09:00'), q)).toBe(false);
    expect(inQuietHours(at('2026-11-10', '14:00'), q)).toBe(false);
    expect(inQuietHours(at('2026-11-10', '14:00'), { start: '10:00', end: '10:00' })).toBe(false);
  });
  it('waits for the end of the window', () => {
    expect(afterQuiet(at('2026-11-10', '03:00'), q)).toBe(at('2026-11-10', '09:00'));
    expect(afterQuiet(at('2026-11-10', '23:00'), q)).toBe(at('2026-11-11', '09:00'));
    expect(afterQuiet(at('2026-11-10', '12:00'), q)).toBe(at('2026-11-10', '12:00'));
  });
});

describe('recurring schedule', () => {
  const m = { frequency: 'monthly', every: 1, dayOfMonth: 31 } as const;
  it('uses the last day of a short month and comes back to the day', () => {
    expect(nextRun('2026-01-31', m)).toBe('2026-02-28');
    expect(nextRun('2026-02-28', m)).toBe('2026-03-31');
    expect(nextRun('2028-01-31', m)).toBe('2028-02-29');
  });
  it('steps weeks, quarters and years, across the year end', () => {
    expect(nextRun('2026-12-28', { frequency: 'weekly', every: 2, dayOfMonth: 1 })).toBe(
      '2027-01-11',
    );
    expect(nextRun('2026-11-15', { frequency: 'quarterly', every: 1, dayOfMonth: 15 })).toBe(
      '2027-02-15',
    );
    expect(nextRun('2026-03-31', { frequency: 'yearly', every: 1, dayOfMonth: 31 })).toBe(
      '2027-03-31',
    );
    expect(nextRun('2026-11-30', { frequency: 'monthly', every: 3, dayOfMonth: 30 })).toBe(
      '2027-02-28',
    );
  });
  it('finds the first run and every run missed in an outage', () => {
    expect(firstRun('2026-11-07', { frequency: 'monthly', every: 1, dayOfMonth: 15 })).toBe(
      '2026-11-15',
    );
    expect(firstRun('2026-11-20', { frequency: 'monthly', every: 1, dayOfMonth: 15 })).toBe(
      '2026-12-15',
    );
    expect(
      dueDates('2026-09-15', '2026-11-20', { frequency: 'monthly', every: 1, dayOfMonth: 15 }),
    ).toEqual(['2026-09-15', '2026-10-15', '2026-11-15']);
    expect(
      dueDates('2026-12-15', '2026-11-20', { frequency: 'monthly', every: 1, dayOfMonth: 15 }),
    ).toEqual([]);
  });
});

describe('templates', () => {
  it('has every message in six languages, each passing the rules Meta applies', () => {
    for (const kind of KINDS)
      for (const lang of LANGUAGES) {
        expect(DEFAULT_BODIES[kind][lang], `${kind} ${lang}`).toBeTruthy();
        expect(templateProblems(DEFAULT_BODIES[kind][lang], kind), `${kind} ${lang}`).toEqual([]);
      }
  });
  it('refuses a body Meta would refuse', () => {
    expect(templateProblems('{{1}} hello {{2}} and {{3}} and {{4}}', 'invoice')).toEqual(
      expect.arrayContaining([
        'a variable cannot start the text',
        'a variable cannot end the text',
      ]),
    );
    expect(templateProblems('Dear {{1}}, {{2}}', 'invoice')).toEqual(
      expect.arrayContaining(['missing {{3}}', 'missing {{4}}']),
    );
    expect(templateProblems('Dear {{1}} {{2}} x {{3}} y {{4}} z {{9}}', 'invoice')).toContain(
      '{{9}} is not a variable of this message',
    );
  });
  it('fills the variables from a document and renders a preview', () => {
    const v = resolveVariables('reminder', {
      party: 'Sharma Stores',
      number: 'INV/26-27/0042',
      amountPaise: 12_345_650n,
      business: 'Asha Traders',
      due: '2026-11-10',
    });
    expect(v).toEqual([
      'Sharma Stores',
      'INV/26-27/0042',
      '₹1,23,456.50',
      '10 Nov 2026',
      'Asha Traders',
    ]);
    expect(renderPreview(DEFAULT_BODIES.reminder.en, v)).toBe(
      'Dear Sharma Stores, a gentle reminder from Asha Traders: invoice INV/26-27/0042 for ₹1,23,456.50 has the due date 10 Nov 2026. Please ignore this if you have already paid.',
    );
    expect(VARIABLES.invoice).toHaveLength(4);
    expect(renderSubject('invoice', 'hi', { number: 'INV/1', business: 'आशा' })).toBe(
      'आशा से चालान INV/1',
    );
  });
  it('writes rupees in Indian grouping and Meta-safe template names', () => {
    expect(rupees(0)).toBe('₹0.00');
    expect(rupees(99_999n)).toBe('₹999.99');
    expect(rupees(100_000_00n)).toBe('₹1,00,000.00');
    expect(rupees(-5_00n)).toBe('-₹5.00');
    expect(templateName('ab12cd34-0000-4000-8000-000000000000', 'invoice')).toBe(
      'gd_ab12cd34_invoice',
    );
  });
});
