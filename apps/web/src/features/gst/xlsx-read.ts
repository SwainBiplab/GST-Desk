/**
 * A small .xlsx reader: the text of every cell of every worksheet, as rows. It reads shared and inline
 * strings, numbers and the saved result of formulas, which is all a downloaded GSTR-2B needs. It does
 * not run anything in the file: no macros, no formulas, no external links.
 */
import { strFromU8, unzipSync } from 'fflate';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const decode = (t: string): string =>
  t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** The text inside every `<t>` element of a fragment, joined (rich text is split into runs). */
const textOf = (xml: string): string =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1] ?? '')).join('');

/** `B` is 1, `AA` is 26 (zero-based columns). */
function columnOf(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface Sheet {
  /** The worksheet's file number in the workbook, in order. */
  index: number;
  rows: string[][];
}

export class XlsxError extends Error {
  override name = 'XlsxError';
}

export function readXlsxSheets(bytes: Uint8Array): Sheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(f.name),
    });
  } catch {
    throw new XlsxError('This is not an Excel (.xlsx) file.');
  }
  const shared = files['xl/sharedStrings.xml']
    ? [
        ...strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g),
      ].map((m) => textOf(m[1] ?? ''))
    : [];
  const sheets: Sheet[] = [];
  const names = Object.keys(files)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  for (const name of names) {
    const xml = strFromU8(files[name]!);
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of (row[1] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const ref = /\br="([A-Z]+\d+)"/i.exec(attrs)?.[1] ?? '';
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        let text: string;
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = textOf(body);
        else text = decode(v);
        const col = ref ? columnOf(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = text;
      }
      rows.push(cells);
    }
    sheets.push({ index: Number(/(\d+)\.xml$/.exec(name)?.[1]), rows });
  }
  if (sheets.length === 0) throw new XlsxError('This Excel file has no worksheets.');
  return sheets;
}
