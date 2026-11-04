import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CONVERSIONS,
  ConversionError,
  buildDocument,
  canConvert,
  computeDocument,
  convertDraft,
  dueDateFor,
  addDays,
  draftFromRows,
  draftToRows,
  duplicateDraft,
  emptyDraft,
  emptyDraftLine,
  isAdjustment,
  isBlankDraft,
  richTextToPlain,
  sanitiseRichText,
  stockEffect,
  validateForIssue,
  type DraftDocument,
  type DraftLine,
  type ValidationContext,
} from '../src';

let n = 0;
const key = () => `k${++n}`;
const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  ...emptyDraftLine(key()),
  description: 'Widget',
  qtyMicros: 2_000_000n,
  ratePaise: 50_000n,
  gstRateBp: 1800,
  ...over,
});
const draft = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  ...emptyDraft('tax_invoice', '2026-05-01', { supplierState: '27' }),
  lines: [line()],
  ...over,
});

describe('buildDocument', () => {
  it('prices an intra-state invoice through the engine and rounds off to the rupee', () => {
    const b = buildDocument(draft());
    // 2 x 500.00 = 1000.00, CGST 90.00 + SGST 90.00
    expect(b.supply).toBe('intra');
    expect(b.money).toMatchObject({
      total_taxable_paise: 100_000,
      total_cgst_paise: 9_000,
      total_sgst_paise: 9_000,
      total_igst_paise: 0,
      round_off_paise: 0,
      total_paise: 118_000,
    });
    expect(b.lines[0]!.row).toMatchObject({
      cgst_bp: 900,
      sgst_bp: 900,
      igst_bp: 0,
      line_no: 1,
      gst_rate_bp: 1800,
    });
    expect(b.trace.length).toBeGreaterThan(3);
  });

  it('charges IGST between states and none under a LUT export', () => {
    const inter = buildDocument(draft({ placeOfSupply: '29' }));
    expect(inter.supply).toBe('inter');
    expect(inter.money).toMatchObject({ total_igst_paise: 18_000, total_cgst_paise: 0 });
    expect(inter.lines[0]!.row).toMatchObject({ igst_bp: 1800, cgst_bp: 0 });

    const exp = buildDocument(draft({ export: true, lut: true, placeOfSupply: '96' }));
    expect(exp.supply).toBe('export');
    expect(exp.money).toMatchObject({ total_igst_paise: 0, total_paise: 100_000 });
  });

  it('backs tax out of a tax-inclusive price', () => {
    const b = buildDocument(
      draft({ lines: [line({ qtyMicros: 1_000_000n, ratePaise: 118_000n, inclusive: true })] }),
    );
    expect(b.money).toMatchObject({ total_taxable_paise: 100_000, total_paise: 118_000 });
    expect(b.lines[0]!.row.price_includes_tax).toBe(true);
  });

  it('applies percent and per-unit line discounts', () => {
    const pct = buildDocument(
      draft({ discountMode: 'percent', lines: [line({ discountValue: 1000n })] }),
    );
    expect(pct.money.total_taxable_paise).toBe(90_000);
    expect(pct.lines[0]!.row).toMatchObject({ discount_mode: 'percent', discount_value: 1000 });
    const unit = buildDocument(
      draft({ discountMode: 'per_unit', lines: [line({ discountValue: 5_000n })] }),
    );
    expect(unit.money.total_taxable_paise).toBe(90_000);
    expect(unit.lines[0]!.row.discount_mode).toBe('per_unit');
  });

  it('allocates an invoice-level discount across lines', () => {
    const b = buildDocument(
      draft({
        invoiceDiscount: { mode: 'amount', paise: 10_000n },
        lines: [line(), line({ ratePaise: 25_000n })],
      }),
    );
    expect(b.totals.invoiceDiscountPaise).toBe(10_000n);
    expect(b.money.total_taxable_paise).toBe(150_000 - 10_000);
  });

  it('leaves tax out of the total under reverse charge but still reports it', () => {
    const b = buildDocument(draft({ reverseCharge: true }));
    expect(b.money.total_paise).toBe(100_000);
    expect(b.totals.rcmTaxPaise).toBe(18_000n);
  });

  it('collects no tax for a composition business', () => {
    const b = buildDocument(draft({ type: 'bill_of_supply', composition: true }));
    expect(b.money).toMatchObject({ total_cgst_paise: 0, total_paise: 100_000 });
  });

  it('ignores blank rows and sequences the others', () => {
    const b = buildDocument(
      draft({ lines: [line(), emptyDraftLine('blank'), line({ ratePaise: 10_000n })] }),
    );
    expect(b.lines.map((l) => l.row.line_no)).toEqual([1, 2]);
  });

  it('matches the engine called directly', () => {
    const d = draft({
      discountMode: 'percent',
      lines: [line({ discountValue: 500n }), line({ gstRateBp: 500, ratePaise: 12_345n })],
    });
    const direct = computeDocument(
      d.lines.map((l) => ({
        qtyMicros: l.qtyMicros,
        ratePaise: l.ratePaise,
        discount: { mode: 'percent' as const, bp: Number(l.discountValue) },
        pricing: 'exclusive' as const,
        gstRateBp: l.gstRateBp,
        cessBp: 0,
        taxability: 'taxable' as const,
      })),
      { supply: 'intra', supplierState: '27', date: d.date, roundOff: 'nearest_rupee' },
    );
    expect(buildDocument(d).totals).toEqual(direct.result.totals);
  });

  it('reprices 200 lines in under 20 ms', () => {
    const d = draft({
      placeOfSupply: '29',
      invoiceDiscount: { mode: 'percent', bp: 250 },
      lines: Array.from({ length: 200 }, (_, i) =>
        line({
          description: `Line ${i}`,
          qtyMicros: BigInt(((i % 9) + 1) * 1_000_000),
          ratePaise: BigInt(10_000 + i),
        }),
      ),
    });
    buildDocument(d); // warm up
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      buildDocument(d);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(20);
  });

  it('never loses a paisa: rows add up to the totals for any draft', () => {
    const arbLine = fc.record({
      qty: fc.integer({ min: 1, max: 500_000_000 }),
      rate: fc.integer({ min: 0, max: 50_000_000 }),
      gst: fc.constantFrom(0, 500, 1200, 1800, 2800),
      mode: fc.constantFrom('none', 'percent', 'per_unit'),
      disc: fc.integer({ min: 0, max: 3000 }),
      inclusive: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(arbLine, { minLength: 1, maxLength: 8 }),
        fc.constantFrom('27', '29', '07'),
        fc.boolean(),
        fc.boolean(),
        (ls, pos, rcm, roundOff) => {
          const d = draft({
            placeOfSupply: pos,
            reverseCharge: rcm,
            roundOff,
            discountMode: ls[0]!.mode as DraftDocument['discountMode'],
            lines: ls.map((x) =>
              line({
                qtyMicros: BigInt(x.qty),
                ratePaise: BigInt(x.rate),
                gstRateBp: x.gst,
                discountValue: BigInt(x.disc),
                inclusive: x.inclusive,
              }),
            ),
          });
          const b = buildDocument(d);
          const sum = (k: keyof (typeof b.lines)[0]['row']) =>
            b.lines.reduce((a, l) => a + Number(l.row[k]), 0);
          for (const l of b.lines) {
            const r = l.row;
            const tax = r.cgst_paise + r.sgst_paise + r.igst_paise + r.utgst_paise + r.cess_paise;
            expect(r.total_paise).toBe(rcm ? r.taxable_paise : r.taxable_paise + tax);
          }
          expect(b.money.total_taxable_paise).toBe(sum('taxable_paise'));
          expect(b.money.total_cgst_paise).toBe(sum('cgst_paise'));
          expect(b.money.total_igst_paise).toBe(sum('igst_paise'));
          expect(b.money.total_paise).toBe(
            sum('total_paise') + b.money.tcs_paise + b.money.round_off_paise,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('validateForIssue', () => {
  const ctx: ValidationContext = { scheme: 'regular' };
  const codes = (d: DraftDocument, c = ctx) =>
    validateForIssue(d, c).map((i) => `${i.field}:${i.code}`);

  it('accepts a complete invoice', () => {
    expect(codes(draft())).toEqual([]);
  });

  it('rejects blank and zero-value documents (FR-037)', () => {
    expect(codes(draft({ lines: [] }))).toContain('lines:no_lines');
    expect(codes(draft({ lines: [emptyDraftLine('x')] }))).toContain('lines:no_lines');
    expect(codes(draft({ lines: [line({ ratePaise: 0n })] }))).toContain('lines:zero_total');
    expect(
      codes(draft({ type: 'delivery_challan', partyId: 'p', lines: [line({ ratePaise: 0n })] })),
    ).toEqual([]);
  });

  it('points at the bad line', () => {
    const issues = validateForIssue(
      draft({
        lines: [
          line(),
          line({ description: '', itemId: null, ratePaise: 5n }),
          line({ qtyMicros: 0n }),
        ],
      }),
      ctx,
    );
    expect(issues).toEqual([
      { field: 'lines', code: 'line_description', line: 1 },
      { field: 'lines', code: 'line_qty', line: 2 },
    ]);
  });

  it('needs a place of supply, and 96 for an export', () => {
    expect(codes(draft({ placeOfSupply: '' }))).toContain('placeOfSupply:pos_required');
    expect(codes(draft({ placeOfSupply: '99x' }))).toContain('placeOfSupply:pos_required');
    expect(codes(draft({ export: true, placeOfSupply: '27' }))).toContain(
      'placeOfSupply:export_pos',
    );
    expect(codes(draft({ export: true, lut: true, placeOfSupply: '96' }))).toEqual([]);
  });

  it('checks dates against the open period and the due date', () => {
    expect(codes(draft({ date: '2025-01-01' }), { ...ctx, openFrom: '2025-04-01' })).toContain(
      'date:date_closed_period',
    );
    expect(codes(draft({ date: '2026-12-01' }), { ...ctx, openTo: '2026-05-01' })).toContain(
      'date:date_future',
    );
    expect(codes(draft({ date: 'nope' }))).toContain('date:date');
    expect(codes(draft({ dueDate: '2026-04-01' }))).toContain('dueDate:due_before_date');
    expect(codes(draft({ dueDate: '2026-06-01' }))).toEqual([]);
  });

  it('needs a party for documents that always name one', () => {
    expect(codes(draft({ type: 'quotation' }))).toContain('party:party_required');
    expect(codes(draft({ type: 'credit_note', partyId: 'p' }))).toEqual([]);
    expect(codes(draft({ type: 'tax_invoice' }))).toEqual([]); // a cash sale
  });

  it('requires a GSTIN on a large invoice to a named party when configured', () => {
    const big = draft({ partyId: 'p', lines: [line({ ratePaise: 50_000_000n })] });
    const withRule = { ...ctx, gstinRequiredAbovePaise: 100_000_000n };
    expect(codes(big, withRule)).toContain('party:gstin_required');
    expect(codes({ ...big, partyGstin: '27AAPFU0939F1ZV' }, withRule)).toEqual([]);
    expect(codes(big)).toEqual([]);
    expect(codes({ ...big, export: true, lut: true, placeOfSupply: '96' }, withRule)).toEqual([]);
  });

  it('needs the supplier invoice on a purchase bill and blocks tax invoices for composition', () => {
    const bill = draft({ type: 'purchase_bill', partyId: 'p' });
    expect(codes(bill)).toEqual([
      'supplierInvoiceNo:supplier_invoice_no',
      'supplierInvoiceDate:date',
    ]);
    expect(codes({ ...bill, supplierInvoiceNo: 'S-1', supplierInvoiceDate: '2026-04-30' })).toEqual(
      [],
    );
    expect(codes(draft(), { scheme: 'composition' })).toContain('type:composition_blocked');
    expect(codes(draft({ type: 'bill_of_supply' }), { scheme: 'composition' })).toEqual([]);
  });

  it('knows a blank draft', () => {
    expect(isBlankDraft(draft({ lines: [emptyDraftLine('a')] }))).toBe(true);
    expect(isBlankDraft(draft())).toBe(false);
    expect(isBlankDraft(draft({ lines: [], partyId: 'p' }))).toBe(false);
  });
});

describe('dates, conversions and stock', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-01-30', 5)).toBe('2026-02-04');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(dueDateFor('2026-05-01', 30)).toBe('2026-05-31');
    expect(dueDateFor('2026-05-01', 0)).toBeNull();
  });

  it('lists what converts into what', () => {
    expect(canConvert('quotation', 'tax_invoice')).toBe(true);
    expect(canConvert('delivery_challan', 'tax_invoice')).toBe(true);
    expect(canConvert('tax_invoice', 'credit_note')).toBe(true);
    expect(canConvert('tax_invoice', 'quotation')).toBe(false);
    expect(canConvert('credit_note', 'tax_invoice')).toBe(false);
    expect(Object.keys(CONVERSIONS).length).toBeGreaterThan(4);
    expect(isAdjustment('credit_note')).toBe(true);
    expect(isAdjustment('tax_invoice')).toBe(false);
  });

  const quote = () =>
    draft({
      type: 'quotation',
      partyId: 'p',
      tcs: { rateBp: 10, cumulativeBeforePaise: 0n },
      dueDate: '2026-06-01',
      lines: [line({ qtyMicros: 5_000_000n }), line({ ratePaise: 1_000n })],
    });

  it('turns a quotation into an invoice draft: same lines, fresh date, no TCS', () => {
    const inv = convertDraft(quote(), 'tax_invoice', '2026-07-01', key);
    expect(inv).toMatchObject({
      type: 'tax_invoice',
      date: '2026-07-01',
      dueDate: null,
      tcs: null,
      partyId: 'p',
    });
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines[0]!.qtyMicros).toBe(5_000_000n);
    expect(new Set(inv.lines.map((l) => l.key)).size).toBe(2);
  });

  it('makes a credit note from selected lines and part quantities, never more than the original', () => {
    const src = draft({
      partyId: 'p',
      lines: [line({ qtyMicros: 10_000_000n }), line({ description: 'Other' })],
    });
    const first = src.lines[0]!.key;
    const cn = convertDraft(src, 'credit_note', '2026-07-01', key, [
      { key: first, qtyMicros: 3_000_000n },
    ]);
    expect(cn.lines).toHaveLength(1);
    expect(cn.lines[0]!.qtyMicros).toBe(3_000_000n);
    expect(() =>
      convertDraft(src, 'credit_note', '2026-07-01', key, [{ key: first, qtyMicros: 11_000_000n }]),
    ).toThrow(ConversionError);
    expect(() =>
      convertDraft(src, 'credit_note', '2026-07-01', key, [{ key: first, qtyMicros: 0n }]),
    ).toThrow(ConversionError);
    expect(() => convertDraft(src, 'credit_note', '2026-07-01', key, [])).toThrow(/at least one/);
    expect(() => convertDraft(src, 'quotation', '2026-07-01', key)).toThrow(ConversionError);
  });

  it('duplicates into a new draft', () => {
    const d = duplicateDraft(draft({ supplierInvoiceNo: 'X', partyId: 'p' }), '2026-08-01', key);
    expect(d).toMatchObject({ date: '2026-08-01', supplierInvoiceNo: '', partyId: 'p' });
  });

  it('knows which documents move stock', () => {
    expect(stockEffect('tax_invoice')).toBe('out');
    expect(stockEffect('purchase_bill')).toBe('in');
    expect(stockEffect('credit_note')).toBe('in');
    expect(stockEffect('purchase_return')).toBe('out');
    expect(stockEffect('quotation')).toBeNull();
    expect(stockEffect('expense')).toBeNull();
  });
});

describe('saving and restoring a draft', () => {
  it('restores a draft that prices to exactly the same totals', () => {
    const d = draft({
      partyId: 'p',
      partyName: 'Sharma',
      partyGstin: '27AAPFU0939F1ZV',
      placeOfSupply: '29',
      discountMode: 'percent',
      invoiceDiscount: { mode: 'percent', bp: 250 },
      tcs: { rateBp: 10, cumulativeBeforePaise: 400_000_000n },
      refs: { po: 'PO-7' },
      notes: '<b>Thanks</b><script>x()</script>',
      terms: 'Pay in <i>30</i> days',
      lines: [
        line({ discountValue: 500n, inclusive: true }),
        line({ gstRateBp: 500, cessBp: 100, ratePaise: 77_777n, note: 'fragile' }),
      ],
    });
    const { doc, lines, built } = draftToRows(d);
    expect(doc.notes).toBe('<b>Thanks</b>');
    expect(doc.supply_type).toBe('inter');
    expect(JSON.stringify(doc.metadata_json)).not.toContain('bigint');
    const back = draftFromRows(
      doc as unknown as Record<string, unknown>,
      lines as unknown as Record<string, unknown>[],
      key,
    );
    expect(back.partyName).toBe('Sharma');
    expect(back.refs).toEqual({ po: 'PO-7' });
    expect(back.invoiceDiscount).toEqual({ mode: 'percent', bp: 250 });
    expect(back.lines.map((l) => l.note)).toEqual(['', 'fragile']);
    expect(buildDocument({ ...back, notes: d.notes }).money).toEqual(built.money);
  });

  it('restores an amount invoice discount and survives JSON', () => {
    const d = draft({
      invoiceDiscount: { mode: 'amount', paise: 12_345n },
      tds: { rateBp: 10, cumulativeBeforePaise: 1n, applicable: true },
    });
    const { doc, lines } = draftToRows(d);
    const stored = JSON.parse(JSON.stringify({ ...doc, metadata_json: doc.metadata_json }));
    const back = draftFromRows(stored, JSON.parse(JSON.stringify(lines)), key);
    expect(back.invoiceDiscount).toEqual({ mode: 'amount', paise: 12_345n });
    expect(back.tds).toEqual({ rateBp: 10, cumulativeBeforePaise: 1n, applicable: true });
  });
});

describe('rich text', () => {
  const evil = [
    '<script>alert(1)</script>hi',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href=" JaVaScRiPt:alert(1)">x</a>',
    '<a href="data:text/html;base64,xxx">x</a>',
    '<b onclick="x()">bold</b>',
    '<svg onload=alert(1)><circle/></svg>',
    '<iframe src="//evil"></iframe>',
    '<style>body{display:none}</style>text',
    '<<script>script>alert(1)<</script>/script>',
    '<p style="x:expression(alert(1))">p</p>',
    '<!-- <script> -->ok',
  ];

  it('removes every active construct', () => {
    for (const html of evil) {
      const out = sanitiseRichText(html);
      expect(out, html).not.toMatch(
        /<script|<iframe|<svg|<style|<img|onerror|onclick|onload|javascript:|data:|style=/i,
      );
    }
  });

  it('keeps safe formatting and safe links', () => {
    expect(
      sanitiseRichText('<p>Pay <b>now</b> &amp; <i>save</i></p><ul><li>one</li><li>two</li></ul>'),
    ).toBe('<p>Pay <b>now</b> &amp; <i>save</i></p><ul><li>one</li><li>two</li></ul>');
    expect(sanitiseRichText('<a href="https://example.com/a?b=1&c=2" onclick="x()">site</a>')).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank">site</a>',
    );
    expect(sanitiseRichText('<a href="mailto:a@b.in">mail</a>')).toContain('mailto:a@b.in');
  });

  it('escapes stray angle brackets, balances tags and drops stray closers', () => {
    expect(sanitiseRichText('1 < 2 & 3 > 2')).toBe('1 &lt; 2 &amp; 3 &gt; 2');
    expect(sanitiseRichText('<b>open <i>nested')).toBe('<b>open <i>nested</i></b>');
    expect(sanitiseRichText('text</b></p>')).toBe('text');
    expect(sanitiseRichText('line<br>break<br/>again')).toBe('line<br>break<br>again');
  });

  it('is idempotent for any input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        const once = sanitiseRichText(s);
        expect(sanitiseRichText(once)).toBe(once);
        expect(once).not.toMatch(/<script|javascript:/i);
      }),
      { numRuns: 300 },
    );
  });

  it('turns markup into plain text with line breaks', () => {
    expect(richTextToPlain('<p>One</p><p>Two &amp; three</p><ul><li>a</li></ul>')).toBe(
      'One\nTwo & three\na',
    );
  });
});
