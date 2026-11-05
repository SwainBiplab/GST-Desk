import { describe, expect, it } from 'vitest';

import type { HsnSuggestion } from '../rules/hsn';

import {
  detectBackupFailure,
  detectDuplicateItems,
  detectDuplicateParties,
  detectHsnSuggestions,
  detectLowStock,
  detectRateChanges,
  detectReminders,
  detectStaleDrafts,
  isoWeekKey,
} from './detectors';
import { applyCorrection, hsnCasesFromAccepted } from './fixtures';
import { INBOX_KINDS, KIND_INFO, TIER0_KINDS, schemaFor } from './kinds';
import { canMove, reconcile, visibilityOf, type Finding } from './lifecycle';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 10, 6, 0, 0);

describe('duplicate parties', () => {
  const parties = [
    {
      id: 'a',
      name: 'Sharma Traders',
      gstin: '27ABCDE1234F1Z5',
      phone: '9820012345',
      createdAt: 1,
    },
    {
      id: 'b',
      name: 'M/s Sharma Traders Pvt. Ltd.',
      gstin: null,
      phone: '+91 98200 12345',
      createdAt: 2,
    },
    { id: 'c', name: 'Verma Stores', gstin: null, phone: '9000000001', createdAt: 3 },
    { id: 'd', name: 'Another Co', gstin: null, phone: null, createdAt: 4 },
  ];
  it('pairs the same business written two ways, keeping the one with a GSTIN', () => {
    const found = detectDuplicateParties(parties);
    expect(found).toHaveLength(1);
    expect(found[0]!.key).toBe('duplicate_party:a:b');
    expect(found[0]!.suggestion).toMatchObject({ keepId: 'a', mergeId: 'b' });
  });
  it('is stable regardless of order', () => {
    expect(detectDuplicateParties([...parties].reverse())[0]!.key).toBe('duplicate_party:a:b');
  });
  it('leaves different people alone', () => {
    expect(detectDuplicateParties(parties.slice(2))).toEqual([]);
  });
});

describe('duplicate items', () => {
  it('flags the same barcode and the same name, not different sizes', () => {
    const f = detectDuplicateItems([
      { id: '1', name: 'Bolt 10mm', kind: 'product', barcode: '111', createdAt: 1 },
      { id: '2', name: 'Bolt 10 mm', kind: 'product', barcode: null, createdAt: 2 },
      { id: '3', name: 'Bolt 12mm', kind: 'product', barcode: null, createdAt: 3 },
      { id: '4', name: 'Other', kind: 'product', barcode: '111', createdAt: 4 },
    ]);
    expect(f.map((x) => x.key).sort()).toEqual(['duplicate_item:1:2', 'duplicate_item:1:4']);
  });
  it('does not mix products and services', () => {
    expect(
      detectDuplicateItems([
        { id: '1', name: 'Repair', kind: 'product', createdAt: 1 },
        { id: '2', name: 'Repair', kind: 'service', createdAt: 2 },
      ]),
    ).toEqual([]);
  });
});

describe('hsn suggestions', () => {
  const hit = (code: string, score: number): HsnSuggestion => ({
    code,
    description: code,
    rateBp: 1800,
    cessBp: 0,
    score,
  });
  it('proposes only for items without an HSN, with confidence from the lead', async () => {
    const f = await detectHsnSuggestions(
      [
        { id: 'a', name: 'Copper wire', hsn: null, gstRateBp: 1800, cessBp: 0 },
        { id: 'b', name: 'Has one', hsn: '7408', gstRateBp: 1800, cessBp: 0 },
        { id: 'c', name: 'Nothing matches', hsn: '', gstRateBp: 0, cessBp: 0 },
      ],
      async (t) => (t === 'Copper wire' ? [hit('7408', 9), hit('7409', 1)] : []),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe('hsn_suggestion:a:7408');
    expect(f[0]!.confidence).toBeCloseTo(0.9, 2);
  });
});

describe('time based detectors', () => {
  it('stale drafts are older than 7 days', () => {
    const f = detectStaleDrafts(
      [
        { id: 'old', label: 'INV draft', updatedAt: NOW - 8 * DAY },
        { id: 'new', label: 'INV draft 2', updatedAt: NOW - 6 * DAY },
      ],
      NOW,
    );
    expect(f.map((x) => x.key)).toEqual(['draft_stale:old']);
    expect(f[0]!.suggestion.ageDays).toBe(8);
  });
  it('reminders are one per customer per week, in their language', () => {
    const deps = {
      languageOf: (s: string | null) => (s === '27' ? 'mr' : 'en'),
      draft: (l: string, v: { name: string }) => `${l}:${v.name}`,
    };
    const f = detectReminders(
      [
        {
          partyId: 'p1',
          name: 'A',
          phone: null,
          stateCode: '27',
          amountPaise: 100,
          invoices: 1,
          oldestDays: 3,
        },
        {
          partyId: 'p2',
          name: 'B',
          phone: null,
          stateCode: null,
          amountPaise: 0,
          invoices: 0,
          oldestDays: 0,
        },
      ],
      NOW,
      deps,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe(`reminder_due:p1:${isoWeekKey(NOW)}`);
    expect(f[0]!.suggestion).toMatchObject({ language: 'mr', message: 'mr:A' });
    expect(isoWeekKey(NOW)).toBe('2026-W24');
  });
  it('low stock once a month per item', () => {
    const f = detectLowStock(
      [
        { id: 'a', name: 'A', onHandMicros: 2, minMicros: 4 },
        { id: 'b', name: 'B', onHandMicros: 9, minMicros: 4 },
        { id: 'c', name: 'C', onHandMicros: 0, minMicros: 0 },
      ],
      NOW,
    );
    expect(f.map((x) => x.key)).toEqual(['low_stock:a:2026-06']);
  });
  it('rate changes only when already in force; backup failure by its time', () => {
    const base = { hsn: '1', oldRateBp: 500, newRateBp: 1200, oldCessBp: 0, newCessBp: 0 };
    const rc = detectRateChanges([
      { ...base, id: 'a', name: 'A', effectiveFrom: '2026-01-01', due: true },
      { ...base, id: 'b', name: 'B', effectiveFrom: '2099-01-01', due: false },
    ]);
    expect(rc.map((x) => x.key)).toEqual(['rate_change:a:1200:0:2026-01-01']);
    expect(detectBackupFailure(null)).toEqual([]);
    expect(detectBackupFailure({ failedAt: 5 })[0]!.key).toBe('backup_failed:5');
  });
});

describe('lifecycle', () => {
  const f = (key: string, kind = 'low_stock'): Finding => ({
    kind,
    key,
    payload: {},
    suggestion: {},
  });
  it('only pending items can move, and only forward', () => {
    expect(canMove('pending', 'accepted')).toBe(true);
    expect(canMove('pending', 'expired')).toBe(true);
    expect(canMove('accepted', 'pending')).toBe(false);
    expect(canMove('rejected', 'accepted')).toBe(false);
  });
  it('snooze hides until its time, then the item is open again', () => {
    expect(visibilityOf({ status: 'pending', snoozedUntil: NOW + 1 }, NOW)).toBe('snoozed');
    expect(visibilityOf({ status: 'pending', snoozedUntil: NOW }, NOW)).toBe('open');
    expect(visibilityOf({ status: 'rejected' }, NOW)).toBe('done');
  });
  it('creates what is new, never what was seen in any state, and expires what cleared', () => {
    const seen = new Map([
      ['k1', { id: '1', status: 'pending', version: 1, kind: 'low_stock' }],
      ['k2', { id: '2', status: 'rejected', version: 2, kind: 'low_stock' }],
      ['k3', { id: '3', status: 'pending', version: 1, kind: 'low_stock' }],
      ['k4', { id: '4', status: 'pending', version: 1, kind: 'draft_stale' }],
    ]);
    const r = reconcile(seen, [f('k1'), f('k2'), f('k5'), f('k5')], ['low_stock']);
    expect(r.create.map((x) => x.key)).toEqual(['k5']);
    // k3 cleared; k4 belongs to a kind that did not run, so it is left alone
    expect(r.expire.map((x) => x.id)).toEqual(['3']);
  });
});

describe('kinds', () => {
  it('every kind has info and a schema; tier 0 kinds are real kinds', () => {
    for (const k of INBOX_KINDS) {
      expect(KIND_INFO[k]).toBeDefined();
      expect(schemaFor(k)).toBeDefined();
    }
    for (const k of TIER0_KINDS) expect(INBOX_KINDS).toContain(k);
  });
});

describe('eval fixtures from accepted items', () => {
  it('uses the edited code when the person changed it', () => {
    const s = { itemId: 'a', itemName: 'Copper wire', code: '7408' };
    const edit = [{ path: 'code', op: 'change' as const, before: '7408', after: '8544' }];
    expect(applyCorrection(s, edit)).toMatchObject({ code: '8544' });
    const cases = hsnCasesFromAccepted([
      { kind: 'hsn_suggestion', suggestion_json: s, correction_json: edit },
      { kind: 'hsn_suggestion', suggestion_json: { itemName: 'Tape', code: '3919' } },
      { kind: 'low_stock', suggestion_json: {} },
    ]);
    expect(cases.map((c) => c.expected)).toEqual([
      { suggestions: [{ code: '8544' }] },
      { suggestions: [{ code: '3919' }] },
    ]);
  });
});
