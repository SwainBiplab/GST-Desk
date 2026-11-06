import { describe, expect, it } from 'vitest';

import { bundleFromSheets, guessSheets, issuesCsv, missingFields } from './model';

const sheet = (id: string, label: string, headers: string[], rows: string[][]) => ({
  id,
  label,
  headers,
  rows,
  lines: rows.map((_, i) => i + 2),
});

describe('migration sheets', () => {
  const sheets = guessSheets([
    sheet(
      '1',
      'Parties',
      ['Party Name', 'GSTIN', 'Phone', 'State'],
      [['Sharma', '27AAPFU0939F1ZV', '9876543210', 'Maharashtra']],
    ),
    sheet(
      '2',
      'Items',
      ['Item Name', 'HSN', 'Unit', 'Selling Price', 'GST %'],
      [['Cement', '2523', 'Bag', '350', '18']],
    ),
    sheet(
      '3',
      'Sale',
      ['Invoice No', 'Date', 'Party Name', 'Item', 'Qty', 'Rate', 'GST %'],
      [['A-1', '2025-04-10', 'Sharma', 'Cement', '2', '350', '18']],
    ),
    sheet('4', 'Notes', ['Foo', 'Bar'], [['x', 'y']]),
  ]);

  it('guesses what each sheet is for', () => {
    expect(sheets.map((s) => s.role)).toEqual(['parties', 'items', 'sales', 'skip']);
    expect(missingFields('sales', sheets[2]!.mapping)).toEqual([]);
    expect(missingFields('sales', {})).toEqual(['number', 'date', 'party']);
    expect(missingFields('skip', {})).toEqual([]);
  });

  it('builds one bundle from the sheets and leaves the skipped one out', () => {
    const b = bundleFromSheets('vyapar', sheets);
    expect(b.source).toBe('vyapar');
    expect(b.parties.map((p) => p.name)).toEqual(['Sharma']);
    expect(b.items.map((i) => i.name)).toEqual(['Cement']);
    expect(b.documents.map((d) => d.number)).toEqual(['A-1']);
    expect(b.issues).toEqual([]);
  });

  it('joins a lines sheet to a header sheet and does not import the lines sheet on its own', () => {
    const head = {
      ...guessSheets([
        sheet(
          'h',
          'Invoices',
          ['Invoice No', 'Date', 'Party Name'],
          [['B-1', '2025-05-01', 'Kumar']],
        ),
      ])[0]!,
      role: 'sales' as const,
    };
    const lines = {
      ...guessSheets([
        sheet(
          'l',
          'Lines',
          ['Invoice No', 'Item', 'Qty', 'Rate', 'GST %'],
          [
            ['B-1', 'Rod', '3', '100', '18'],
            ['Z-9', 'Rod', '1', '1', '18'],
          ],
        ),
      ])[0]!,
      role: 'skip' as const,
    };
    const b = bundleFromSheets('excel', [{ ...head, linesFrom: 'l' }, lines]);
    expect(b.documents).toHaveLength(1);
    expect(b.documents[0]).toMatchObject({ number: 'B-1', partyName: 'Kumar' });
    expect(b.issues.map((i) => i.message).join('|')).toMatch(/no invoice Z-9/);
  });

  it('names the sheet in a problem when there are several', () => {
    const bad = guessSheets([
      sheet('1', 'Parties', ['Party Name', 'GSTIN', 'Phone', 'State'], [['', '', '', '']]),
      sheets[1]!,
    ]);
    const b = bundleFromSheets('excel', [{ ...bad[0]!, rows: [['', 'x', '', '']] }]);
    expect(b.issues.length).toBeGreaterThanOrEqual(0);
    expect(
      issuesCsv([{ severity: 'error', ref: 'line 2', message: 'a, "b"' }]).replace(
        new RegExp('^\\uFEFF'),
        '',
      ),
    ).toBe('Severity,Where,What\r\nerror,line 2,"a, ""b"""\r\n');
  });
});
