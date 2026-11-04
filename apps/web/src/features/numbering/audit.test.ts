import { describe, expect, it } from 'vitest';

import { auditCsv, diffRows, showValue, type AuditEntry } from './audit';

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 'a1',
  table_name: 'documents',
  row_id: 'r1',
  action: 'update',
  before_json: null,
  after_json: null,
  actor: 'asha',
  at: Date.UTC(2026, 4, 1, 10, 0, 0),
  ...over,
});

describe('audit diff', () => {
  it('lists only the fields that changed and ignores version and timestamps', () => {
    const out = diffRows(
      { total_paise: 100, notes: 'a', version: 1, updated_at: 1 },
      { total_paise: 120, notes: 'a', version: 2, updated_at: 2 },
    );
    expect(out).toEqual([{ field: 'total_paise', before: '100', after: '120' }]);
  });

  it('shows every field of an insert and of a removal', () => {
    expect(diffRows(null, { number: 'INV/1', status: 'issued' }).map((c) => c.field)).toEqual([
      'number',
      'status',
    ]);
    expect(diffRows({ name: 'x' }, null)).toEqual([{ field: 'name', before: 'x', after: '' }]);
  });

  it('treats a number and its text as equal, and JSON key order as irrelevant', () => {
    expect(diffRows({ n: 5 }, { n: '5' })).toEqual([]);
    expect(diffRows({ m: { a: 1, b: 2 } }, { m: { b: 2, a: 1 } })).toEqual([]);
    expect(diffRows({ m: { a: 1 } }, { m: { a: 2 } })).toHaveLength(1);
  });

  it('writes objects as text', () => {
    expect(showValue({ a: 1 })).toBe('{"a":1}');
    expect(showValue(null)).toBe('');
  });
});

describe('audit CSV', () => {
  it('has one row per changed field and a header', () => {
    const csv = auditCsv([
      entry({
        before_json: { notes: 'a', total_paise: 1 },
        after_json: { notes: 'b', total_paise: 1 },
      }),
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('When,Who,Record type,Record id,Action,Field,Before,After');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('notes,a,b');
  });

  it('neutralises spreadsheet formulas in values', () => {
    const csv = auditCsv([
      entry({ before_json: { notes: 'x' }, after_json: { notes: '=HYPERLINK("http://evil")' } }),
    ]);
    expect(csv).toContain("'=HYPERLINK");
  });
});
