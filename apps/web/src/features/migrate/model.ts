import {
  ITEM_FIELDS,
  PARTY_FIELDS,
  parseCsv,
  toCsv,
  type FieldDef,
  type Mapping,
} from '@gst/domain';
import {
  DOCUMENT_FIELDS,
  classifySheet,
  detectDocumentMapping,
  detectItemMapping,
  detectPartyMapping,
  documentsFromRows,
  emptyBundle,
  itemsFromRows,
  joinSheets,
  partiesFromRows,
  type ImportBundle,
  type ImportIssue,
  type ImportSource,
} from '@gst/interop';

import type { PreparedSheet } from './read-file';

export type Role = 'parties' | 'items' | 'sales' | 'purchases' | 'skip';

export interface SheetState extends PreparedSheet {
  role: Role;
  mapping: Mapping;
  /** The id of another sheet that holds this sheet's lines, or empty when each row is already a line. */
  linesFrom: string;
}

export const FIELDS_OF: Record<Exclude<Role, 'skip'>, readonly FieldDef[]> = {
  parties: PARTY_FIELDS,
  items: ITEM_FIELDS,
  sales: DOCUMENT_FIELDS,
  purchases: DOCUMENT_FIELDS,
};

export function detectFor(role: Role, headers: readonly string[]): Mapping {
  if (role === 'parties') return detectPartyMapping(headers);
  if (role === 'items') return detectItemMapping(headers);
  if (role === 'sales' || role === 'purchases') return detectDocumentMapping(headers);
  return {};
}

/** A first guess at what each sheet is for, and how its columns map. */
export function guessSheets(sheets: readonly PreparedSheet[]): SheetState[] {
  return sheets.map((s) => {
    const { kind } = classifySheet(s.headers);
    const purchase = /purchase|bill|supplier|vendor/i.test(s.label + ' ' + s.headers.join(' '));
    const role: Role =
      kind === 'parties'
        ? 'parties'
        : kind === 'items'
          ? 'items'
          : kind === 'documents'
            ? purchase
              ? 'purchases'
              : 'sales'
            : 'skip';
    return { ...s, role, mapping: detectFor(role, s.headers), linesFrom: '' };
  });
}

/** The field keys a role needs that no column is mapped to. */
export const missingFields = (role: Role, mapping: Mapping): string[] =>
  role === 'skip'
    ? []
    : FIELDS_OF[role]
        .filter((f) => f.required && (mapping[f.key] ?? null) === null)
        .map((f) => f.key);

/** Turn the sheets a person has set up into one bundle, with a problem for every row that cannot be read. */
export function bundleFromSheets(
  source: Exclude<ImportSource, 'tally'>,
  sheets: readonly SheetState[],
): ImportBundle {
  const out = emptyBundle(source);
  const consumed = new Set(sheets.map((s) => s.linesFrom).filter(Boolean));
  const label = (s: SheetState) => (sheets.length > 1 ? `sheet ${s.label}, ` : '');
  const tag = (issues: ImportIssue[], s: SheetState) =>
    issues.map((i) => ({ ...i, ref: `${label(s)}${i.ref}` }));
  for (const s of sheets) {
    if (s.role === 'skip' || consumed.has(s.id)) continue;
    if (s.role === 'parties') {
      const r = partiesFromRows({ rows: s.rows, lines: s.lines, mapping: s.mapping });
      out.parties.push(...r.parties);
      out.issues.push(...tag(r.issues, s));
    } else if (s.role === 'items') {
      const r = itemsFromRows({ rows: s.rows, lines: s.lines, mapping: s.mapping });
      out.items.push(...r.items);
      out.issues.push(...tag(r.issues, s));
    } else {
      let headers = s.headers;
      let rows = s.rows;
      let lines = s.lines;
      let mapping = s.mapping;
      const other = s.linesFrom ? sheets.find((x) => x.id === s.linesFrom) : undefined;
      if (other) {
        const headKey = s.mapping['number'] ?? 0;
        const linesKey = detectDocumentMapping(other.headers)['number'] ?? 0;
        const j = joinSheets(
          { headers: s.headers, rows: s.rows },
          { headers: other.headers, rows: other.rows },
          headKey,
          linesKey,
        );
        headers = j.headers;
        rows = j.rows;
        lines = j.rows.map((_, i) => i + 2);
        mapping = detectDocumentMapping(headers);
        out.issues.push(...tag(j.issues, s));
      }
      const r = documentsFromRows({
        source,
        headers,
        rows,
        lines,
        mapping,
        defaultType: s.role === 'purchases' ? 'purchase_bill' : 'tax_invoice',
      });
      out.documents.push(...r.documents);
      out.issues.push(...tag(r.issues, s));
    }
  }
  return out;
}

/** The problems of a review as a CSV file a person can sort and send to whoever is helping. */
export function issuesCsv(issues: readonly ImportIssue[]): string {
  return toCsv([
    ['Severity', 'Where', 'What'],
    ...issues.map((i) => [i.severity, i.ref, i.message]),
  ]);
}

export { parseCsv };
