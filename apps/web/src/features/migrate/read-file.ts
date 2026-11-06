import { parseCsv } from '@gst/domain';
import { TallyReader, sniffXmlEncoding, type ImportBundle } from '@gst/interop';

import { readXlsxSheets } from '@/features/gst/xlsx-read';

/** One sheet of a spreadsheet, ready to map: the heading row, the rows under it, and the file line of each. */
export interface PreparedSheet {
  id: string;
  label: string;
  headers: string[];
  rows: string[][];
  lines: number[];
}

/**
 * Read a Tally export without holding it: the file is decoded as it streams in (UTF-16 is common) and each
 * piece goes to the reader, so a very large file costs the same memory as a small one.
 */
export async function readTallyFile(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<ImportBundle> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const encoding = sniffXmlEncoding(head);
  const reader = new TallyReader();
  const pieces = file.stream().pipeThrough(new TextDecoderStream(encoding)).getReader();
  const bytesPerChar = encoding === 'utf-8' ? 1 : 2;
  let seen = 0;
  for (;;) {
    const { done, value } = await pieces.read();
    if (done) break;
    reader.feed(value);
    seen += value.length * bytesPerChar;
    onProgress(Math.min(1, seen / Math.max(1, file.size)));
  }
  onProgress(1);
  return reader.finish();
}

/** The heading row is the first one with at least two filled cells; blank rows before it are skipped. */
function prepare(
  id: string,
  label: string,
  all: string[][],
  fileLines?: number[],
): PreparedSheet | null {
  const start = all.findIndex((r) => r.filter((c) => c.trim() !== '').length >= 2);
  if (start < 0) return null;
  const headers = all[start]!.map((h) => h.trim());
  const rows: string[][] = [];
  const lines: number[] = [];
  for (let i = start + 1; i < all.length; i++) {
    const r = all[i]!;
    if (r.every((c) => c.trim() === '')) continue;
    rows.push(r);
    lines.push(fileLines?.[i] ?? i + 1);
  }
  return { id, label, headers, rows, lines };
}

/** The sheets of an Excel workbook, or the one sheet of a CSV file. */
export async function readSheetsFile(file: File): Promise<PreparedSheet[]> {
  if (/\.(csv|txt|tsv)$/i.test(file.name)) {
    const parsed = parseCsv(await file.text());
    const one = prepare('csv', file.name, parsed.rows, parsed.lines);
    return one ? [one] : [];
  }
  const sheets = readXlsxSheets(new Uint8Array(await file.arrayBuffer()));
  return sheets
    .map((s) => prepare(`sheet${s.index}`, `${s.index}`, s.rows))
    .filter((s): s is PreparedSheet => s !== null);
}
