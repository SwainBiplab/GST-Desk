import { build, type Dialect } from './dialect';
import { SPEC } from './spec';

export * from './dialect';
export * from './spec';

export type TableName = (typeof SPEC)[number]['name'];
/** Drizzle tables, one per spec entry. Compiled per dialect; identical keys. */
export type Schema = Record<TableName, any>;
/** Rows use snake_case keys exactly as stored. */
export type Row = Record<string, any>;
export type NewRow = Record<string, any>;

export function buildSchema(dialect: Dialect): Schema {
  return build(dialect, SPEC) as Schema;
}
