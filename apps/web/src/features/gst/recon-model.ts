/** The reconciliation screen without React: filters, counts, tiles and which actions a row offers. */
import type { ReconRow } from '@gst/db';
import { total, type MatchClass, type Summary } from '@gst/domain';

export type ClassFilter = 'all' | MatchClass;

export const CLASS_FILTERS: ClassFilter[] = [
  'all',
  'matched_with_differences',
  'in_2b_not_in_books',
  'in_books_not_in_2b',
  'duplicate_in_books',
  'matched',
];

const supplierOf = (r: ReconRow): string => r.entry?.supplierGstin ?? r.bill?.supplierGstin ?? '';

/** The rows of one class (or all) whose supplier, name or number contains the text. */
export function filterRows(
  rows: readonly ReconRow[],
  f: { cls: ClassFilter; q: string },
): ReconRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.cls !== 'all' && r.match.cls !== f.cls) return false;
    if (!q) return true;
    return [supplierOf(r), r.entry?.supplierName ?? '', r.entry?.number ?? '', r.bill?.number ?? '']
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

export function countByClass(rows: readonly ReconRow[]): Record<ClassFilter, number> {
  const out: Record<ClassFilter, number> = {
    all: rows.length,
    matched: 0,
    matched_with_differences: 0,
    in_2b_not_in_books: 0,
    in_books_not_in_2b: 0,
    duplicate_in_books: 0,
  };
  for (const r of rows) out[r.match.cls] += 1;
  return out;
}

export type TileKey = 'per2b' | 'perBooks' | 'eligible' | 'defer' | 'reverse' | 'only2b';

/** The six tiles, as total tax in paise. */
export function tiles(s: Summary): { key: TileKey; paise: number }[] {
  return [
    { key: 'per2b', paise: total(s.per2b) },
    { key: 'perBooks', paise: total(s.perBooks) },
    { key: 'eligible', paise: total(s.eligible) },
    { key: 'defer', paise: total(s.toDefer) },
    { key: 'reverse', paise: total(s.toReverse) },
    { key: 'only2b', paise: total(s.only2b) },
  ];
}

export type RowAction = 'accept' | 'link' | 'createBill' | 'toFile' | 'ignore' | 'undo';

/** What a person can do with a row. A row that has a decision can only be undone. */
export function actionsFor(r: ReconRow): RowAction[] {
  if (r.decision) return ['undo'];
  switch (r.match.cls) {
    case 'matched':
    case 'matched_with_differences':
      return ['accept'];
    case 'in_2b_not_in_books':
      return ['createBill', 'link', 'ignore'];
    case 'in_books_not_in_2b':
      return ['toFile', 'ignore'];
    case 'duplicate_in_books':
      return ['ignore'];
  }
}

/** How many exact matches have no decision yet (what "accept all" would accept). */
export const acceptableCount = (rows: readonly ReconRow[]): number =>
  rows.filter((r) => r.match.cls === 'matched' && !r.decision && !r.carried).length;

/** The bills still waiting for the supplier to report them, for linking a stray 2B line by hand. */
export const linkableBills = (rows: readonly ReconRow[]): ReconRow[] =>
  rows.filter((r) => r.match.cls === 'in_books_not_in_2b' && !r.decision && r.bill);
