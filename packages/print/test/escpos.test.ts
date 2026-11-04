import { describe, expect, it } from 'vitest';

import {
  CMD,
  encodeText,
  feed,
  isPrintable,
  qrCommand,
  rasterCommand,
  receiptBytes,
  receiptHtml,
  receiptLines,
  receiptText,
  twoColumns,
  wrapCols,
  presetSpec,
  thermalColumns,
  type Raster,
  type TemplateSpec,
} from '../src';

import { sampleModel } from './helpers';

const thermal = (widthMm: 58 | 80): TemplateSpec => ({
  ...presetSpec('retail'),
  thermal: {
    widthMm,
    showBusiness: true,
    showTaxSummary: false,
    footer: 'Thank you. Visit again.',
  },
});

const find = (bytes: Uint8Array, seq: readonly number[], from = 0): number => {
  outer: for (let i = from; i <= bytes.length - seq.length; i++) {
    for (let k = 0; k < seq.length; k++) if (bytes[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
};
const ascii = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('commands, byte for byte', () => {
  it('initialise, align, bold, size, feed, cut and drawer', () => {
    expect([...CMD.init]).toEqual([0x1b, 0x40]);
    expect([...CMD.center]).toEqual([0x1b, 0x61, 1]);
    expect([...CMD.right]).toEqual([0x1b, 0x61, 2]);
    expect([...CMD.boldOn]).toEqual([0x1b, 0x45, 1]);
    expect([...CMD.size2]).toEqual([0x1d, 0x21, 0x11]);
    expect(feed(4)).toEqual([0x1b, 0x64, 4]);
    expect(feed(999)).toEqual([0x1b, 0x64, 255]);
    expect([...CMD.cut]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect([...CMD.drawer]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });

  it('a QR carries its data length in two bytes and ends with the print command', () => {
    const q = qrCommand('upi://pay?pa=a@b');
    const data = 'upi://pay?pa=a@b';
    const n = data.length + 3;
    const store = find(Uint8Array.from(q), [0x1d, 0x28, 0x6b, n, 0x00, 0x31, 0x50, 0x30]);
    expect(store).toBeGreaterThan(0);
    expect(q.slice(-8)).toEqual([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
    // a long payload needs the high length byte
    const long = qrCommand('x'.repeat(300));
    const at = find(Uint8Array.from(long), [0x1d, 0x28, 0x6b, 303 % 256, 1, 0x31, 0x50]);
    expect(at).toBeGreaterThan(0);
  });

  it('a raster image has its size in the header', () => {
    const r: Raster = { widthBytes: 3, height: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) };
    expect(rasterCommand(r)).toEqual([0x1d, 0x76, 0x30, 0, 3, 0, 2, 0, 1, 2, 3, 4, 5, 6]);
  });

  it('encodes Latin text and replaces what a printer cannot print', () => {
    expect(encodeText('Total 12')).toEqual([...'Total 12'].map((c) => c.charCodeAt(0)));
    expect(encodeText('é')).toEqual([0x82]);
    expect(encodeText('कुल')).toEqual([0x3f, 0x3f, 0x3f]);
    expect(isPrintable('abc 1,2')).toBe(true);
    expect(isPrintable('₹')).toBe(false);
  });
});

describe('text on a roll', () => {
  it('a 58 mm roll holds 32 characters and an 80 mm roll 48', () => {
    expect(thermalColumns(58)).toBe(32);
    expect(thermalColumns(80)).toBe(48);
  });

  it('puts two texts on one line, shortening the left one rather than overflowing', () => {
    expect(twoColumns('Total', '100.00', 20)).toBe(`Total${' '.repeat(9)}100.00`);
    expect(twoColumns('A very long item name here', '100.00', 20)).toHaveLength(20);
    expect(twoColumns('A very long item name here', '100.00', 20).endsWith('100.00')).toBe(true);
  });

  it('wraps on spaces and cuts a word longer than the roll', () => {
    expect(wrapCols('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapCols('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapCols('', 10)).toEqual(['']);
  });

  for (const mm of [58, 80] as const) {
    it(`${mm} mm: no line is longer than the roll, and the total is on the right`, () => {
      const spec = thermal(mm);
      const cols = thermalColumns(mm);
      const model = sampleModel({ lines: 4 });
      const lines = receiptLines(model, spec);
      for (const l of lines) {
        if (l.rule || l.qr) continue;
        const width = l.size === 2 ? Math.floor(cols / 2) : cols;
        expect(l.text.length, l.text).toBeLessThanOrEqual(width);
      }
      const total = lines.find((l) => l.bold && l.text.includes('Total'))!;
      expect(total.text).toMatch(/Total\s+Rs [\d,]+\.\d\d$/);
      expect(total.text.endsWith(`Rs ${model.totals.total.replace('₹', '')}`)).toBe(true);
      // every line's right-hand amount lines up: all full-width two-column lines are exactly `cols` long
      for (const l of lines.filter((x) => /\d\.\d\d$/.test(x.text) && x.size !== 2 && !x.rule))
        expect(l.text.length).toBe(cols);
    });
  }

  it('prints each line item as a name and then a quantity, rate and amount', () => {
    const lines = receiptLines(sampleModel({ lines: 2 }), thermal(80));
    const i = lines.findIndex((l) => l.text.startsWith('Widget number 1'));
    expect(lines[i]!.text).toContain('Widget number 1');
    const next = lines.slice(i).find((l) => /^2 x /.test(l.text))!;
    expect(next.text).toMatch(/^2 x [\d,]+\.\d\d\s+[\d,]+\.\d\d$/);
  });

  it('hides the business block, shows the tax summary and the footer when asked', () => {
    const spec = {
      ...thermal(80),
      thermal: { widthMm: 80 as const, showBusiness: false, showTaxSummary: true, footer: 'Bye' },
    };
    const t = receiptText(receiptLines(sampleModel(), spec), 48);
    expect(t).not.toContain('Demo Traders');
    expect(t).toContain('Tax Summary');
    expect(t).toContain('Bye');
  });

  it('states CANCELLED on a cancelled document', () => {
    expect(
      receiptText(receiptLines(sampleModel({ status: 'cancelled' }), thermal(80)), 48),
    ).toContain('CANCELLED');
  });

  it('the browser fallback is the same lines at the roll width', () => {
    const html = receiptHtml(sampleModel(), thermal(58));
    expect(html).toContain('width:58mm');
    expect(html).toContain('Tax Invoice');
    expect(html).not.toContain('<script');
    const escaped = receiptHtml(
      {
        ...sampleModel(),
        party: { name: '<b>x</b> & y', gstin: null, address: [], stateName: null, phone: null },
      },
      thermal(80),
    );
    expect(escaped).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
  });
});

describe('the bytes of a receipt', () => {
  const model = sampleModel({ lines: 3 });

  it('starts by initialising the printer and ends with feed and a cut', () => {
    const b = receiptBytes(model, thermal(80));
    expect([...b.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect(find(b, CMD.cut)).toBeGreaterThan(0);
    expect(b.slice(-4)).toEqual(Uint8Array.from(CMD.cut));
    expect(find(b, CMD.drawer)).toBe(-1);
  });

  it('kicks the cash drawer on request, after the cut', () => {
    const b = receiptBytes(model, thermal(80), { cashDrawer: true });
    expect(find(b, CMD.drawer)).toBeGreaterThan(find(b, CMD.cut));
  });

  it('contains the business, the items and the total as printable text', () => {
    const t = ascii(receiptBytes(model, thermal(80)));
    expect(t).toContain('Demo Traders');
    expect(t).toContain('Widget number 1');
    expect(t).toContain('Tax Invoice');
    expect(t).toContain(`Rs ${model.totals.total.replace('₹', '')}`);
  });

  it('prints the UPI QR natively', () => {
    const b = receiptBytes(model, thermal(80));
    expect(find(b, [0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])).toBeGreaterThan(0);
  });

  it('a Hindi receipt without a bitmap drawer prints in English, with no question-mark noise', () => {
    const spec = { ...thermal(80), language: 'hi' as const };
    const t = ascii(receiptBytes(model, spec));
    expect(t).toContain('Tax Invoice');
    expect((t.match(/\?/g) ?? []).length).toBeLessThan(3);
  });

  it('with a bitmap drawer, Hindi lines are sent as images', () => {
    const spec = { ...thermal(80), language: 'hi' as const };
    const seen: string[] = [];
    const b = receiptBytes(model, spec, {
      rasterize: (text) => {
        seen.push(text);
        return { widthBytes: 1, height: 1, data: Uint8Array.from([0xff]) };
      },
    });
    expect(seen.some((s) => s.includes('कर चालान'))).toBe(true);
    expect(find(b, [0x1d, 0x76, 0x30, 0x00, 1, 0, 1, 0, 0xff])).toBeGreaterThan(0);
  });

  it('a long receipt stays small', () => {
    expect(receiptBytes(sampleModel({ lines: 100 }), thermal(80)).length).toBeLessThan(20_000);
  });
});
