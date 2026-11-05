import {
  buildDocument,
  emptyDraft,
  emptyDraftLine,
  isBlankLine,
  type DraftDocument,
  type DraftLine,
} from '@gst/domain';
import { describe, expect, it } from 'vitest';

import { checkAttachment, sniffMime, MAX_ATTACHMENT_BYTES } from './files';
import {
  GRID_COLUMNS,
  applyItem,
  applyParty,
  cellText,
  moveLine,
  pasteBlock,
  qtyText,
  removeLines,
  sameIssues,
  setCell,
  updateLine,
  withTrailingBlank,
} from './state';
import { stepsFor } from './trace-view';

const units = new Map([['u-nos', 'NOS']]);
const byCode = new Map([['NOS', 'u-nos']]);
const ctx = (mode: DraftDocument['discountMode'] = 'none') => ({
  discountMode: mode,
  unitsByCode: byCode,
});

const fresh = (over: Partial<DraftDocument> = {}): DraftDocument =>
  withTrailingBlank({
    ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
    ...over,
  });
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(`k${Math.random()}`),
  description: 'Widget',
  ratePaise: 10_000n,
  gstRateBp: 1800,
  ...over,
});

const item = {
  id: 'i1',
  name: 'Tea',
  hsn: '0902',
  unit_id: 'u-nos',
  sale_rate_paise: 12_000,
  purchase_rate_paise: 9_000,
  gst_rate_bp: 500,
  cess_bp: 100,
  tax_inclusive: true,
};

describe('trailing blank row', () => {
  it('always ends with exactly one blank row to type into', () => {
    expect(fresh().lines).toHaveLength(1);
    expect(isBlankLine(fresh().lines[0]!)).toBe(true);
    const filled = withTrailingBlank({ ...fresh(), lines: [line()] });
    expect(filled.lines).toHaveLength(2);
    expect(isBlankLine(filled.lines[1]!)).toBe(true);
    const many = withTrailingBlank({
      ...fresh(),
      lines: [line(), emptyDraftLine('a'), emptyDraftLine('b'), emptyDraftLine('c')],
    });
    expect(many.lines).toHaveLength(2);
  });

  it('returns the same object when nothing needs to change', () => {
    const d = fresh();
    expect(withTrailingBlank(d)).toBe(d);
  });
});

describe('applying an item', () => {
  it('takes name, HSN, unit, price, rate, cess and whether the price includes tax', () => {
    const l = applyItem(emptyDraftLine('k'), item, 'tax_invoice');
    expect(l).toMatchObject({
      itemId: 'i1',
      description: 'Tea',
      hsn: '0902',
      unitId: 'u-nos',
      ratePaise: 12_000n,
      gstRateBp: 500,
      cessBp: 100,
      inclusive: true,
    });
  });

  it('uses the purchase price on purchases, and never treats a bought price as tax-inclusive', () => {
    const l = applyItem(emptyDraftLine('k'), item, 'purchase_bill');
    expect(l.ratePaise).toBe(9_000n);
    expect(l.inclusive).toBe(false);
  });

  it('keeps the quantity already typed', () => {
    expect(
      applyItem({ ...emptyDraftLine('k'), qtyMicros: 5_000_000n }, item, 'tax_invoice').qtyMicros,
    ).toBe(5_000_000n);
  });
});

describe('applying a party', () => {
  const party = {
    id: 'p1',
    name: 'Rao Works',
    gstin: '29AAAAA0000A1Z5',
    state_code: '29',
    credit_days: 15,
  };

  it('sets the place of supply to the party state and the due date from its credit days', () => {
    const d = applyParty(fresh(), party, { businessState: '27' });
    expect(d).toMatchObject({
      partyId: 'p1',
      partyName: 'Rao Works',
      partyGstin: '29AAAAA0000A1Z5',
      partyState: '29',
      placeOfSupply: '29',
      supplierState: '27',
      dueDate: '2026-05-16',
      export: false,
    });
  });

  it('flips the roles for a purchase: the party is the supplier', () => {
    const d = applyParty(fresh({ type: 'purchase_bill' }), party, { businessState: '27' });
    expect(d).toMatchObject({ supplierState: '29', placeOfSupply: '27', dueDate: null });
  });

  it('sends an export party to 96 and a SEZ party through the SEZ flag', () => {
    expect(
      applyParty(fresh(), { ...party, is_export: true }, { businessState: '27' }),
    ).toMatchObject({
      export: true,
      placeOfSupply: '96',
    });
    expect(applyParty(fresh(), { ...party, is_sez: true }, { businessState: '27' }).sez).toBe(true);
  });

  it('clears the party when none is chosen', () => {
    const d = applyParty(applyParty(fresh(), party, { businessState: '27' }), null, {
      businessState: '27',
    });
    expect(d).toMatchObject({ partyId: null, partyName: '', partyGstin: null, partyState: null });
  });

  it('changes the tax the engine charges', () => {
    const base = fresh({ lines: [line()] });
    const intra = buildDocument(
      applyParty(base, { ...party, state_code: '27' }, { businessState: '27' }),
    );
    const inter = buildDocument(applyParty(base, party, { businessState: '27' }));
    expect(intra.money.total_igst_paise).toBe(0);
    expect(inter.money.total_igst_paise).toBeGreaterThan(0);
  });
});

describe('grid cells', () => {
  const l = line({ qtyMicros: 2_500_000n, ratePaise: 12_345n, hsn: '0902', unitId: 'u-nos' });
  const built = buildDocument(fresh({ lines: [l] })).lines[0];
  const c = { units, discountMode: 'none' as const, built };

  it('shows each column as text', () => {
    expect(GRID_COLUMNS.map((col) => cellText(l, col, c))).toEqual([
      'Widget',
      '0902',
      '2.5',
      'NOS',
      '123.45',
      '',
      '',
      '308.63',
      '18',
      '55.56',
      '364.19',
      '',
    ]);
  });

  it('shows the discount in the document mode', () => {
    const d = { ...l, discountValue: 1000n };
    expect(cellText(d, 'discount', { ...c, discountMode: 'percent' })).toBe('10');
    expect(cellText(d, 'discount', { ...c, discountMode: 'per_unit' })).toBe('10.00');
    expect(cellText(d, 'discount', c)).toBe('');
  });

  it('reads typed text into the row', () => {
    expect(setCell(l, 'qty', '3', ctx()).line.qtyMicros).toBe(3_000_000n);
    expect(setCell(l, 'qty', '1,250.5', ctx()).line.qtyMicros).toBe(1_250_500_000n);
    expect(setCell(l, 'qty', '', ctx()).line.qtyMicros).toBe(1_000_000n);
    expect(setCell(l, 'rate', '₹ 1,23,456.50', ctx()).line.ratePaise).toBe(12_345_650n);
    expect(setCell(l, 'rate', '', ctx()).line.ratePaise).toBe(0n);
    expect(setCell(l, 'hsn', '0902 10', ctx()).line.hsn).toBe('090210');
    expect(setCell(l, 'unit', 'nos', ctx()).line.unitId).toBe('u-nos');
    expect(setCell(l, 'unit', '', ctx()).line.unitId).toBeNull();
    expect(setCell(l, 'incl', 'Yes', ctx()).line.inclusive).toBe(true);
    expect(setCell(l, 'taxRate', '12', ctx()).line.gstRateBp).toBe(1200);
    expect(setCell(l, 'note', '  fragile  ', ctx()).line.note).toBe('fragile');
    expect(setCell(l, 'discount', '10', ctx('percent')).line.discountValue).toBe(1000n);
    expect(setCell(l, 'discount', '2.50', ctx('per_unit')).line.discountValue).toBe(250n);
  });

  it('reports what it cannot read and changes nothing', () => {
    for (const [col, text, error] of [
      ['qty', 'abc', 'qty'],
      ['qty', '-1', 'qty'],
      ['qty', '0', 'qty'],
      ['rate', '1.234', 'rate'],
      ['hsn', '12', 'hsn'],
      ['unit', 'zzz', 'unit'],
      ['taxRate', '7', 'gst_rate'],
      ['discount', 'x', 'discount'],
    ] as const) {
      const out = setCell(l, col, text, ctx(col === 'discount' ? 'percent' : 'none'));
      expect(out.error, `${col} ${text}`).toBe(error);
      expect(out.line).toBe(l);
    }
    expect(setCell(l, 'discount', '150', ctx('percent')).error).toBe('discount');
  });

  it('ignores edits to a discount when the document has none, and to computed cells', () => {
    expect(setCell(l, 'discount', '10', ctx('none')).line).toBe(l);
    expect(setCell(l, 'total', '5', ctx()).line).toBe(l);
  });

  it('unlinks the item when the name is retyped', () => {
    const linked = { ...l, itemId: 'i1', description: 'Tea' };
    expect(setCell(linked, 'item', 'Tea', ctx()).line.itemId).toBe('i1');
    expect(setCell(linked, 'item', 'Coffee', ctx()).line.itemId).toBeNull();
  });

  it('formats quantities without trailing zeros', () => {
    expect(qtyText(2_000_000n)).toBe('2');
    expect(qtyText(2_500_000n)).toBe('2.5');
    expect(qtyText(1_234_567n)).toBe('1.234567');
  });
});

describe('editing rows', () => {
  const three = () => {
    const ls = [line({ description: 'A' }), line({ description: 'B' }), line({ description: 'C' })];
    return fresh({ lines: ls });
  };

  it('updates one row and keeps the blank row at the end', () => {
    const d = three();
    const next = updateLine(d, d.lines[0]!.key, (x) => ({ ...x, description: 'A2' }));
    expect(next.lines.map((x) => x.description).slice(0, 3)).toEqual(['A2', 'B', 'C']);
    expect(isBlankLine(next.lines[next.lines.length - 1]!)).toBe(true);
  });

  it('moves a row', () => {
    const d = three();
    expect(
      moveLine(d, 0, 2)
        .lines.map((x) => x.description)
        .slice(0, 3),
    ).toEqual(['B', 'C', 'A']);
    expect(moveLine(d, 1, 1)).toBe(d);
    expect(moveLine(d, 0, 99)).toBe(d);
  });

  it('removes selected rows', () => {
    const d = three();
    const next = removeLines(d, new Set([d.lines[1]!.key]));
    expect(next.lines.map((x) => x.description).slice(0, 2)).toEqual(['A', 'C']);
  });
});

describe('pasting from a spreadsheet', () => {
  const cols = GRID_COLUMNS;

  it('fills a block, adds the rows it needs and keeps a blank row at the end', () => {
    const { draft, rejected } = pasteBlock(
      fresh(),
      cols,
      0,
      0,
      [
        ['Bolt', '7318', '10', 'NOS', '2.50'],
        ['Nut', '7318', '20', 'NOS', '1.25'],
        ['Washer', '', '5', '', '0.50'],
      ],
      byCode,
    );
    expect(rejected).toEqual([]);
    expect(draft.lines.map((x) => x.description).slice(0, 3)).toEqual(['Bolt', 'Nut', 'Washer']);
    expect(draft.lines[1]).toMatchObject({
      qtyMicros: 20_000_000n,
      ratePaise: 125n,
      hsn: '7318',
      unitId: 'u-nos',
    });
    expect(isBlankLine(draft.lines[draft.lines.length - 1]!)).toBe(true);
  });

  it('reports cells it cannot read and skips them', () => {
    const { draft, rejected } = pasteBlock(
      fresh(),
      cols,
      0,
      0,
      [['Pipe', '', 'many', '', '9.99']],
      byCode,
    );
    expect(rejected).toEqual([{ row: 0, col: 'qty', error: 'qty' }]);
    expect(draft.lines[0]).toMatchObject({
      description: 'Pipe',
      ratePaise: 999n,
      qtyMicros: 1_000_000n,
    });
  });

  it('does not paste into computed columns', () => {
    const { draft } = pasteBlock(
      fresh({ lines: [line()] }),
      cols,
      7,
      0,
      [['999', '99', '9999']],
      byCode,
    );
    expect(draft.lines[0]!.ratePaise).toBe(10_000n);
  });

  it('starts at the cell it was pasted on', () => {
    const { draft } = pasteBlock(
      fresh({ lines: [line(), line({ description: 'B' })] }),
      cols,
      2,
      1,
      [['7']],
      byCode,
    );
    expect(draft.lines[1]!.qtyMicros).toBe(7_000_000n);
    expect(draft.lines[0]!.qtyMicros).toBe(1_000_000n);
  });
});

describe('the trace', () => {
  const d = fresh({ lines: [line(), line({ description: 'Second', gstRateBp: 500 })], tcs: null });
  const built = buildDocument(d);

  it('picks the steps of one line, with the line prefix removed', () => {
    const steps = stepsFor(built, { kind: 'line', key: d.lines[1]!.key });
    const rules = steps.map((s) => s.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['line.gross', 'line.taxable', 'line.gst', 'line.total']),
    );
    expect(rules.every((r) => !r.startsWith('lines['))).toBe(true);
    expect(steps.find((s) => s.rule === 'line.gst')!.note).toContain('2.5%');
  });

  it('picks the document steps for the totals', () => {
    const rules = stepsFor(built, { kind: 'document' }).map((s) => s.rule);
    expect(rules).toEqual(expect.arrayContaining(['doc.lines_total', 'doc.total']));
    expect(rules.some((r) => r.startsWith('line.'))).toBe(false);
  });

  it('knows nothing about a row that is not priced', () => {
    expect(stepsFor(built, { kind: 'line', key: 'gone' })).toEqual([]);
  });
});

describe('purchase bill attachments', () => {
  const bytes = (...b: number[]) => new Uint8Array(b);
  const pdf = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31);
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);
  const jpg = bytes(0xff, 0xd8, 0xff, 0xe0);
  const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);

  it('recognises files by their first bytes, not their names', () => {
    expect(sniffMime(pdf)).toBe('application/pdf');
    expect(sniffMime(png)).toBe('image/png');
    expect(sniffMime(jpg)).toBe('image/jpeg');
    expect(sniffMime(webp)).toBe('image/webp');
    expect(sniffMime(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull();
    expect(sniffMime(new TextEncoder().encode('MZ executable'))).toBeNull();
    expect(sniffMime(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeNull(); // RIFF WAVE
  });

  it('refuses empty, oversize and unknown files', () => {
    expect(checkAttachment(pdf)).toEqual({ ok: true, mime: 'application/pdf' });
    expect(checkAttachment(new Uint8Array(0))).toEqual({ ok: false, reason: 'empty' });
    expect(checkAttachment(bytes(1, 2, 3))).toEqual({ ok: false, reason: 'type' });
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(pdf);
    expect(checkAttachment(big)).toEqual({ ok: false, reason: 'too_big' });
  });
});

describe('comparing problem lists (so the grid does not redraw on every keystroke)', () => {
  const a = [{ field: 'lines', code: 'qty', line: 2 }];
  it('treats the same problems in a new array as the same', () => {
    expect(sameIssues(a, [{ field: 'lines', code: 'qty', line: 2 }])).toBe(true);
    expect(sameIssues([], [])).toBe(true);
    expect(sameIssues(a, a)).toBe(true);
  });
  it('sees a different problem, line or count', () => {
    expect(sameIssues(a, [])).toBe(false);
    expect(sameIssues(a, [{ field: 'lines', code: 'qty', line: 3 }])).toBe(false);
    expect(sameIssues(a, [{ field: 'lines', code: 'rate', line: 2 }])).toBe(false);
    expect(sameIssues(a, [{ field: 'party', code: 'qty', line: 2 }])).toBe(false);
    expect(sameIssues(a, [...a, { field: 'date', code: 'missing' }])).toBe(false);
  });
});
