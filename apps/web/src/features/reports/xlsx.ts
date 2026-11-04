/**
 * A small .xlsx writer: one sheet, typed cells (text, numbers, dates as text), a bold header row and a
 * frozen first row. The file is a zip of a few XML parts, made with fflate, so no spreadsheet library
 * ships to the browser.
 *
 * Formula safety (FR-071): every text cell is written as an inline string, which a spreadsheet never
 * evaluates, so a party named `=HYPERLINK(...)` shows as that text. Numbers are real numbers.
 */
import { strToU8, zipSync } from 'fflate';

export type XlsxCell =
  string | number | null | { n: number; fmt: 'money' | 'qty' | 'int' | 'percent' | 'date' };

export interface XlsxSheet {
  name: string;
  header: string[];
  rows: XlsxCell[][];
  /** A closing row (totals) drawn bold. */
  footer?: XlsxCell[];
  /** Column widths in characters; defaults to a fit on the header. */
  widths?: number[];
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Escape text for XML, dropping the control characters XML 1.0 cannot carry. */
export function xmlText(v: string): string {
  let out = '';
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (
      c === 0x9 ||
      c === 0xa ||
      c === 0xd ||
      (c >= 0x20 && c <= 0xd7ff) ||
      (c >= 0xe000 && c <= 0xfffd) ||
      c >= 0x10000
    ) {
      out +=
        ch === '&'
          ? '&amp;'
          : ch === '<'
            ? '&lt;'
            : ch === '>'
              ? '&gt;'
              : ch === '"'
                ? '&quot;'
                : ch;
    }
  }
  return out;
}

/** Spreadsheet column letters: 0 is A, 26 is AA. */
export function columnName(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// style ids in styles.xml below
const STYLE = {
  plain: 0,
  bold: 1,
  money: 2,
  qty: 3,
  int: 4,
  percent: 5,
  moneyBold: 6,
  date: 7,
} as const;

const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]-#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.000"/><numFmt numFmtId="166" formatCode="dd-mm-yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

function cellXml(ref: string, cell: XlsxCell, bold: boolean): string {
  if (cell === null || cell === '') return '';
  if (typeof cell === 'string') {
    return `<c r="${ref}" t="inlineStr"${bold ? ` s="${STYLE.bold}"` : ''}><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
  }
  const value = typeof cell === 'number' ? cell : cell.n;
  const fmt = typeof cell === 'number' ? null : cell.fmt;
  const style =
    fmt === 'money'
      ? bold
        ? STYLE.moneyBold
        : STYLE.money
      : fmt === 'qty'
        ? STYLE.qty
        : fmt === 'int'
          ? STYLE.int
          : fmt === 'percent'
            ? STYLE.percent
            : fmt === 'date'
              ? STYLE.date
              : bold
                ? STYLE.bold
                : STYLE.plain;
  return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${Number.isFinite(value) ? value : 0}</v></c>`;
}

function sheetXml(sheet: XlsxSheet): string {
  const cols = sheet.header.length;
  const widths =
    sheet.widths ??
    sheet.header.map((h, i) => {
      let w = h.length + 4;
      for (const r of sheet.rows.slice(0, 200)) {
        const c = r[i];
        if (typeof c === 'string') w = Math.max(w, Math.min(c.length + 2, 48));
      }
      return Math.max(w, 12);
    });
  const out: string[] = [
    `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`,
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`,
    '<sheetData>',
  ];
  const row = (n: number, cells: XlsxCell[], bold: boolean) => {
    let x = `<row r="${n}">`;
    for (let i = 0; i < cols; i++) x += cellXml(`${columnName(i)}${n}`, cells[i] ?? null, bold);
    out.push(`${x}</row>`);
  };
  row(1, sheet.header, true);
  sheet.rows.forEach((r, i) => row(i + 2, r, false));
  if (sheet.footer) row(sheet.rows.length + 2, sheet.footer, true);
  out.push('</sheetData></worksheet>');
  return out.join('');
}

/** A sheet name Excel accepts: at most 31 characters, none of `\ / ? * [ ] :`. */
export function sheetName(name: string): string {
  const cleaned = name
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .slice(0, 31);
  return cleaned || 'Report';
}

/** The workbook as bytes. */
export function toXlsx(sheet: XlsxSheet): Uint8Array {
  const name = xmlText(sheetName(sheet.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(sheet)),
  };
  // fixed timestamps keep the bytes the same for the same data
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2020, 0, 1)) });
}
