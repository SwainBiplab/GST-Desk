import type { Ctx, Database } from '@gst/db';
import type { FieldDef, Mapping } from '@gst/domain';

/** One thing wrong with a row: the field it belongs to and a code that `val.<code>` turns into words. */
export interface ImportProblem {
  field: string;
  code: string;
}

export interface ImportReview {
  total: number;
  valid: { line: number; values: Record<string, unknown>; raw: string[] }[];
  invalid: { line: number; problems: ImportProblem[]; raw: string[] }[];
}

export interface ImportInput {
  headers: string[];
  /** Data rows only (no header). */
  rows: string[][];
  /** Physical file line of each data row, for error reports. */
  lines: number[];
  mapping: Mapping;
  database: Database;
  ctx: Ctx;
}

/** What differs between importing items and importing parties. */
export interface ImportSpec {
  entity: 'items' | 'parties';
  fields: readonly FieldDef[];
  /** Check every row (no writes). */
  review(input: ImportInput): Promise<ImportReview>;
  /** Write the rows in one transaction. Returns how many were stored. */
  commit(args: {
    values: Record<string, unknown>[];
    database: Database;
    ctx: Ctx;
    onProgress: (done: number, total: number) => void;
    shouldCancel: () => boolean;
  }): Promise<number>;
  /** Text of an example file. */
  template: string;
  templateName: string;
}
