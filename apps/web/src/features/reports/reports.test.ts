import { REPORTS } from '@gst/db';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  csvValue,
  defaultColumns,
  exportColumns,
  layoutLines,
  qtyText,
  rateText,
  readReportState,
  showCell,
  toCsvText,
  toSheet,
  writeReportState,
  type ExportInput,
} from './model';
import { columnName, sheetName, toXlsx, xmlText } from './xlsx';

const t = (key: string, opts?: Record<string, unknown>) =>
  `${key}${opts?.['defaultValue'] ? `|${String(opts['defaultValue'])}` : ''}`;
const today = '2025-02-12';

describe('report state in the address', () => {
  it('reads nothing for a missing or unknown report', () => {
    expect(readReportState({}, today)).toBeNull();
    expect(readReportState({ report: 'nope' }, today)).toBeNull();
  });

  it('defaults to this financial year', () => {
    const s = readReportState({ report: 'sales_register' }, today)!;
    expect(s).toMatchObject({
      id: 'sales_register',
      preset: 'this_fy',
      from: '2024-04-01',
      to: '2025-03-31',
      partyId: null,
      type: null,
      side: 'receivable',
      book: 'all',
      group: null,
      cols: null,
    });
  });

  it('uses the preset, and custom dates only when the preset is custom', () => {
    const month = readReportState(
      { report: 'sales_register', preset: 'this_month', from: '2020-01-01' },
      today,
    )!;
    expect([month.from, month.to]).toEqual(['2025-02-01', '2025-02-28']);
    const custom = readReportState(
      { report: 'sales_register', preset: 'custom', from: '2025-01-10', to: '2025-01-20' },
      today,
    )!;
    expect([custom.preset, custom.from, custom.to]).toEqual(['custom', '2025-01-10', '2025-01-20']);
    // dates without a preset mean custom
    expect(readReportState({ report: 'sales_register', from: '2025-01-10' }, today)!.preset).toBe(
      'custom',
    );
  });

  it('swaps dates that are the wrong way round and ignores ones that are not dates', () => {
    const s = readReportState(
      { report: 'sales_register', preset: 'custom', from: '2025-02-10', to: '2025-01-01' },
      today,
    )!;
    expect([s.from, s.to]).toEqual(['2025-01-01', '2025-02-10']);
    const bad = readReportState(
      { report: 'sales_register', preset: 'custom', from: 'tomorrow', to: '12/02/2025' },
      today,
    )!;
    expect([bad.from, bad.to]).toEqual(['2025-02-12', '2025-02-12']);
  });

  it('accepts only the document types and columns a report has', () => {
    expect(readReportState({ report: 'sales_register', type: 'credit_note' }, today)!.type).toBe(
      'credit_note',
    );
    expect(
      readReportState({ report: 'sales_register', type: 'purchase_bill' }, today)!.type,
    ).toBeNull();
    const s = readReportState(
      { report: 'sales_register', group: 'taxable', cols: 'date,bogus,total' },
      today,
    )!;
    expect(s.group).toBeNull(); // taxable is not a grouping column
    expect(s.cols).toEqual(['date', 'total']);
    expect(readReportState({ report: 'sales_register', group: 'party' }, today)!.group).toBe(
      'party',
    );
  });

  it('gst_summary always reads one side, outward by default', () => {
    expect(readReportState({ report: 'gst_summary' }, today)!.type).toBe('outward');
    expect(readReportState({ report: 'gst_summary', type: 'inward' }, today)!.type).toBe('inward');
  });

  it('writes a short address and reads the same state back', () => {
    const states = [
      { report: 'sales_register' },
      {
        report: 'sales_register',
        preset: 'last_month',
        party: 'p1',
        group: 'party',
        type: 'credit_note',
      },
      { report: 'party_outstanding', side: 'payable' },
      { report: 'receipts_payments', book: 'cash', preset: 'today' },
      { report: 'gst_summary', type: 'inward', preset: 'this_month' },
      {
        report: 'sales_register',
        preset: 'custom',
        from: '2025-01-10',
        to: '2025-01-20',
        cols: 'date,total',
      },
    ];
    for (const search of states) {
      const s = readReportState(search, today)!;
      const written = writeReportState(s);
      expect(readReportState(written, today)).toEqual(s);
    }
    expect(writeReportState(readReportState({ report: 'sales_register' }, today)!)).toEqual({
      report: 'sales_register',
    });
  });
});

describe('showing cells', () => {
  const col = (id: keyof typeof REPORTS, key: string) =>
    REPORTS[id].columns.find((c) => c.key === key)!;

  it('shows money in Indian grouping without a symbol, negatives with a minus', () => {
    const c = col('sales_register', 'total');
    expect(showCell('sales_register', c, 12345678, t)).toBe('1,23,456.78');
    expect(showCell('sales_register', c, -5000, t)).toBe('-50.00');
    expect(showCell('sales_register', c, 0, t)).toBe('0.00');
  });

  it('shows dates as dd-mm-yyyy, quantities and rates plainly', () => {
    expect(showCell('sales_register', col('sales_register', 'date'), '2025-02-03', t)).toBe(
      '03-02-2025',
    );
    expect(qtyText(2_500_000)).toBe('2.5');
    expect(qtyText(3_000_000)).toBe('3');
    expect(qtyText(-1_250_000)).toBe('-1.25');
    expect(qtyText(1_234_567)).toBe('1.234');
    expect(rateText(1800)).toBe('18%');
    expect(rateText(250)).toBe('2.5%');
    expect(rateText(0)).toBe('0%');
  });

  it('translates coded text', () => {
    expect(showCell('sales_register', col('sales_register', 'type'), 'tax_invoice', t)).toContain(
      'docs.types.tax_invoice',
    );
    expect(showCell('day_book', col('day_book', 'kind'), 'receipt', t)).toBe(
      'reports.kind.receipt',
    );
    expect(showCell('party_sales', col('party_sales', 'party'), 'Walk-in', t)).toBe(
      'reports.walkIn',
    );
    expect(showCell('sales_register', col('sales_register', 'party'), 'Sharma & Sons', t)).toBe(
      'Sharma & Sons',
    );
  });
});

describe('grouping', () => {
  const columns = REPORTS.sales_register.columns;
  const rows = [
    { id: '1', type: 'tax_invoice', party: 'B', taxable: 100, total: 118 },
    { id: '2', type: 'credit_note', party: 'A', taxable: -40, total: -47 },
    { id: '3', type: 'tax_invoice', party: 'A', taxable: 60, total: 71 },
  ];

  it('leaves rows alone without a grouping column', () => {
    const lines = layoutLines('sales_register', columns, rows, null, t);
    expect(lines.map((l) => l.kind)).toEqual(['row', 'row', 'row']);
  });

  it('gathers rows under a heading per value, each group ends with its subtotal', () => {
    const lines = layoutLines('sales_register', columns, rows, 'party', t);
    expect(lines.map((l) => l.kind)).toEqual([
      'group',
      'row',
      'row',
      'subtotal',
      'group',
      'row',
      'subtotal',
    ]);
    const [a, b] = lines.filter((l) => l.kind === 'subtotal');
    expect(a).toMatchObject({ key: 'A', totals: { taxable: 20, total: 24 } });
    expect(b).toMatchObject({ key: 'B', totals: { taxable: 100, total: 118 } });
    expect(lines[0]).toMatchObject({ kind: 'group', label: 'A', count: 2 });
  });

  it('subtotals add up to the grand total', () => {
    const lines = layoutLines('sales_register', columns, rows, 'type', t);
    const sum = lines.reduce(
      (acc, l) => (l.kind === 'subtotal' ? acc + (l.totals['taxable'] ?? 0) : acc),
      0,
    );
    expect(sum).toBe(120);
  });
});

describe('export', () => {
  const def = REPORTS.sales_register;
  const columns = exportColumns(def, null);
  const input = (rows: Record<string, string | number | null>[]): ExportInput => ({
    id: 'sales_register',
    columns,
    rows,
    totals: { taxable: 7000, cgst: 0, sgst: 0, igst: 0, total: 8260 },
    title: 'Sales register',
    totalLabel: 'Total',
    header: (c) => c.key,
    t,
  });

  it('exports the columns on screen in their order, not the hidden ones', () => {
    expect(columns.map((c) => c.key)).toEqual(defaultColumns(def));
    expect(columns.map((c) => c.key)).not.toContain('gstin');
    expect(exportColumns(def, ['total', 'date']).map((c) => c.key)).toEqual(['total', 'date']);
  });

  it('is formula-safe: text that starts like a formula is neutralised, real negatives are not', () => {
    const csv = toCsvText(
      input([
        {
          id: '1',
          date: '2025-01-01',
          number: 'INV/1',
          type: 'tax_invoice',
          party: '=HYPERLINK("http://evil","click")',
          taxable: -5000,
          cgst: 0,
          sgst: 0,
          igst: 0,
          total: -5900,
        },
        {
          id: '2',
          date: '2025-01-02',
          number: '+91-99',
          type: 'tax_invoice',
          party: '@SUM(A1)',
          taxable: 100,
          cgst: 0,
          sgst: 0,
          igst: 0,
          total: 118,
        },
      ]),
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff); // Excel needs the byte order mark for Indian names
    const lines = csv.slice(1).split('\r\n');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(lines[1]).toContain(',-50.00,'); // a negative amount stays a number
    expect(lines[2]).toContain("'+91-99");
    expect(lines[2]).toContain("'@SUM(A1)");
    for (const line of lines.slice(1, 3)) expect(line).not.toMatch(/(^|,)[=+@]/);
    expect(lines[3]).toMatch(/^Total,/); // totals row
    expect(lines[3]).toContain('70.00');
  });

  it('writes amounts as plain decimals in rupees', () => {
    const c = columns.find((x) => x.key === 'total')!;
    expect(csvValue('sales_register', c, 123456, t)).toEqual({ numeric: '1234.56' });
    expect(csvValue('sales_register', c, -5, t)).toEqual({ numeric: '-0.05' });
  });
});

describe('xlsx', () => {
  const sheet = toSheet({
    id: 'sales_register',
    columns: exportColumns(REPORTS.sales_register, null),
    rows: [
      {
        id: '1',
        date: '2025-01-01',
        number: 'INV/1',
        type: 'tax_invoice',
        party: "=cmd|' /C calc'!A0 & <b>",
        taxable: 123456,
        cgst: 0,
        sgst: 0,
        igst: 0,
        total: -118,
      },
    ],
    totals: { taxable: 123456, total: -118 },
    title: 'Sales register',
    totalLabel: 'Total',
    header: (c) => c.key,
    t,
  });
  const files = unzipSync(toXlsx(sheet));
  const sheetXml = strFromU8(files['xl/worksheets/sheet1.xml']!);

  it('is a workbook with the parts a spreadsheet needs', () => {
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('name="Sales register"');
  });

  it('writes text as inline strings and amounts as real numbers in rupees', () => {
    // text never becomes a formula, and markup in it is escaped
    expect(sheetXml).toContain('t="inlineStr"');
    expect(sheetXml).not.toMatch(/<f>/);
    expect(sheetXml).toContain('=cmd|&apos;'.replace('&apos;', "'"));
    expect(sheetXml).toContain('&amp; &lt;b&gt;');
    // 123456 paise is 1234.56 rupees as a number, with the money style
    expect(sheetXml).toMatch(/<c r="E2" s="2"><v>1234.56<\/v><\/c>/);
    // a date is a real date (45658 is 1 January 2025) with a date style, not text
    expect(sheetXml).toMatch(/<c r="A2" s="7"><v>45658<\/v><\/c>/);
    expect(sheetXml).toMatch(/<v>-1.18<\/v>/);
  });

  it('has a bold header, a bold totals row and a frozen top row', () => {
    expect(sheetXml).toMatch(/<row r="1"><c r="A1" t="inlineStr" s="1">/);
    expect(sheetXml).toMatch(
      /<row r="3"><c r="A3" t="inlineStr" s="1"><is><t xml:space="preserve">Total/,
    );
    expect(sheetXml).toContain('state="frozen"');
  });

  it('gives the same bytes for the same data', () => {
    expect(Buffer.from(toXlsx(sheet)).equals(Buffer.from(toXlsx(sheet)))).toBe(true);
  });

  it('names columns and sheets the way a spreadsheet does', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnName)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'ZZ',
      'AAA',
    ]);
    expect(sheetName('Sales/register: Q1?')).toBe('Sales register  Q1');
    expect(sheetName('x'.repeat(50))).toHaveLength(31);
    expect(sheetName('///')).toBe('Report');
  });

  it('drops characters XML cannot hold', () => {
    expect(xmlText('a\u0000b\u0007c\u000bd')).toBe('abcd');
    expect(xmlText('tab\there')).toBe('tab\there');
    expect(xmlText('हिन्दी ₹ 😀')).toBe('हिन्दी ₹ 😀');
  });

  it('writes 50,000 rows in a few seconds', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => [
      `INV/${i}`,
      `Party ${i % 200}`,
      { n: (i % 997) * 1.18, fmt: 'money' as const },
    ]);
    const started = performance.now();
    const bytes = toXlsx({ name: 'Big', header: ['Number', 'Party', 'Total'], rows });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(bytes.length).toBeGreaterThan(100_000);
  }, 30_000);
});
