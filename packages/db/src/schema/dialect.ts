/**
 * Dialect abstraction: tables are described once as data (see spec.ts) and compiled to
 * Drizzle `sqlite-core` or `pg-core` tables. Keys are snake_case in both TS and SQL.
 */
import { sql } from 'drizzle-orm';
import * as pg from 'drizzle-orm/pg-core';
import * as sq from 'drizzle-orm/sqlite-core';

export type Dialect = 'sqlite' | 'pg';

type Kind = 'uuid' | 'text' | 'int' | 'big' | 'bool' | 'json' | 'ts' | 'date';

interface ColOpts {
  nn?: boolean;
  def?: string | number | boolean;
  ref?: string;
  unique?: boolean;
  pk?: boolean;
  enum?: readonly string[];
}

export class Col {
  constructor(
    readonly kind: Kind,
    readonly o: ColOpts = {},
  ) {}
  private with(o: ColOpts) {
    return new Col(this.kind, { ...this.o, ...o });
  }
  get nn() {
    return this.with({ nn: true });
  }
  get unique() {
    return this.with({ unique: true });
  }
  get pk() {
    return this.with({ pk: true, nn: true });
  }
  default(v: string | number | boolean) {
    return this.with({ def: v });
  }
  ref(table: string) {
    return this.with({ ref: table });
  }
  oneOf(values: readonly string[]) {
    return this.with({ enum: values });
  }
}

export const c = {
  uuid: () => new Col('uuid'),
  text: () => new Col('text'),
  int: () => new Col('int'),
  /** Integer paise / micros. JS number (safe up to 2^53). */
  big: () => new Col('big'),
  bool: () => new Col('bool'),
  json: () => new Col('json'),
  /** Epoch milliseconds. */
  ts: () => new Col('ts'),
  /** Calendar date as `YYYY-MM-DD`. */
  date: () => new Col('date'),
};

export interface IndexSpec {
  cols: string[];
  unique?: boolean;
  /** Raw SQL predicate for a partial index. */
  where?: string;
}

export type TableKind = 'tenant' | 'tenant-lite' | 'org' | 'plain';

export interface TableSpec {
  name: string;
  kind: TableKind;
  cols: Record<string, Col>;
  indexes?: IndexSpec[];
}

const NOW = {
  sqlite: sql`(unixepoch() * 1000)`,
  pg: sql`(extract(epoch from now()) * 1000)::bigint`,
};

function buildCol(dialect: Dialect, name: string, col: Col, tables: Record<string, any>): any {
  const { o } = col;
  let b: any;
  if (dialect === 'sqlite') {
    switch (col.kind) {
      case 'uuid':
      case 'date':
        b = sq.text(name);
        break;
      case 'text':
        b = o.enum ? sq.text(name, { enum: o.enum as [string, ...string[]] }) : sq.text(name);
        break;
      case 'int':
      case 'big':
      case 'ts':
        b = sq.integer(name);
        break;
      case 'bool':
        b = sq.integer(name, { mode: 'boolean' });
        break;
      case 'json':
        b = sq.text(name, { mode: 'json' });
        break;
    }
  } else {
    switch (col.kind) {
      case 'uuid':
        b = pg.uuid(name);
        break;
      case 'text':
        b = pg.text(name);
        break;
      case 'int':
        b = pg.integer(name);
        break;
      case 'big':
      case 'ts':
        b = pg.bigint(name, { mode: 'number' });
        break;
      case 'bool':
        b = pg.boolean(name);
        break;
      case 'json':
        b = pg.jsonb(name);
        break;
      case 'date':
        b = pg.date(name, { mode: 'string' });
        break;
    }
  }
  if (o.pk) b = b.primaryKey();
  if (o.nn) b = b.notNull();
  if (o.unique) b = b.unique();
  if (o.def !== undefined) b = b.default(o.def);
  if (o.ref) {
    const target = o.ref;
    b = b.references(() => tables[target].id);
  }
  return b;
}

/** Common columns added to every tenant table. */
function commonCols(kind: TableKind): Record<string, Col> {
  const id = c.uuid().pk;
  const stamps = {
    version: c.int().nn.default(1),
    created_at: c.ts().nn,
    updated_at: c.ts().nn,
  };
  switch (kind) {
    case 'tenant':
      return {
        id,
        org_id: c.uuid().nn.ref('organisations'),
        business_id: c.uuid().nn.ref('businesses'),
        ...stamps,
        deleted_at: c.ts(),
        created_by: c.text(),
        updated_by: c.text(),
      };
    case 'tenant-lite':
      return {
        id,
        org_id: c.uuid().nn.ref('organisations'),
        business_id: c.uuid().nn.ref('businesses'),
        created_at: c.ts().nn,
      };
    case 'org':
      return {
        id,
        org_id: c.uuid().nn.ref('organisations'),
        ...stamps,
        deleted_at: c.ts(),
        created_by: c.text(),
        updated_by: c.text(),
      };
    case 'plain':
      return { id, ...stamps, deleted_at: c.ts() };
  }
}

export function indexName(table: string, spec: IndexSpec) {
  return `${table}_${spec.cols.join('_')}_${spec.unique ? 'uq' : 'idx'}`;
}

export function build(dialect: Dialect, specs: TableSpec[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const spec of specs) {
    const all = { ...commonCols(spec.kind), ...spec.cols };
    const cols: Record<string, any> = {};
    for (const [k, col] of Object.entries(all)) {
      let b = buildCol(dialect, k, col, out);
      if (k === 'created_at' || k === 'updated_at') b = b.default(NOW[dialect]);
      cols[k] = b;
    }
    const idx: IndexSpec[] = [...(spec.indexes ?? [])];
    if (spec.kind === 'tenant' || spec.kind === 'tenant-lite') {
      idx.push({ cols: ['business_id'] });
    }
    if (spec.kind !== 'plain') idx.push({ cols: ['org_id'] });
    const mk = (t: Record<string, any>) =>
      idx.map((i) => {
        const name = indexName(spec.name, i);
        const on = i.cols.map((k) => t[k]);
        const lib = dialect === 'sqlite' ? sq : pg;
        let ix = (i.unique ? lib.uniqueIndex(name) : lib.index(name)).on(
          ...(on as [any, ...any[]]),
        );
        if (i.where) ix = ix.where(sql.raw(i.where));
        return ix;
      });
    out[spec.name] =
      dialect === 'sqlite'
        ? sq.sqliteTable(spec.name, cols, mk as any)
        : pg.pgTable(spec.name, cols, mk as any);
  }
  return out;
}

export function allColumns(spec: TableSpec): Record<string, Col> {
  return { ...commonCols(spec.kind), ...spec.cols };
}
