import { parse2bJson, parse2bTable, type ParsedReturn2B } from '@gst/domain';

import { readXlsxSheets, XlsxError } from './xlsx-read';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Read a downloaded GSTR-2B (the portal's JSON, or its Excel workbook) into lines. */
export async function parseReturnFile(
  file: File,
  month: string,
  gstin: string,
): Promise<{ parsed: ParsedReturn2B; source: 'json' | 'xlsx'; hash: string | undefined }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error('This file is larger than 25 MB.');
  let hash: string | undefined;
  try {
    hash = hex(await crypto.subtle.digest('SHA-256', bytes));
  } catch {
    hash = undefined; // no secure context: the file is still read
  }
  const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zipped || /\.xlsx$/i.test(file.name)) {
    const entries: ParsedReturn2B['entries'] = [];
    const problems: string[] = [];
    let reverseCharge = 0;
    let found = false;
    for (const sheet of readXlsxSheets(bytes)) {
      const r = parse2bTable(sheet.rows, { period: month, gstin });
      // a sheet with no table (the read-me, the summary) is not a problem
      if (r.problems.length === 1 && r.problems[0]!.startsWith('No table')) continue;
      found = true;
      entries.push(...r.entries);
      problems.push(...r.problems);
      reverseCharge += r.reverseChargeLeftOut ?? 0;
    }
    if (!found)
      throw new XlsxError('No sheet with a table of supplier bills was found in this file.');
    return {
      parsed: {
        period: month,
        gstin,
        version: 'xlsx-v1',
        entries,
        problems,
        reverseChargeLeftOut: reverseCharge,
      },
      source: 'xlsx',
      hash,
    };
  }
  return { parsed: parse2bJson(new TextDecoder().decode(bytes)), source: 'json', hash };
}
