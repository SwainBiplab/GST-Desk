/**
 * Postgres through postgres.js, wrapped as the `Database` every repository in `@gst/db` takes. Two
 * connections: the migration user (owner) for schema work, and `gst_app` for requests, so row-level
 * security is enforced on every query the API runs.
 */
import { buildSchema, type Database } from '@gst/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

export interface PgDatabase extends Database {
  sql: Sql;
}

export function openPostgres(
  url: string,
  opts: { max?: number; appName?: string } = {},
): PgDatabase {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    // epoch milliseconds in and out: the shared schema stores times as numbers
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: unknown) => String(v),
        parse: (v: string) => Number(v),
      },
    },
    connection: { application_name: opts.appName ?? 'gst-api' },
    onnotice: () => undefined,
  });
  const db = drizzle(sql);
  return {
    dialect: 'pg',
    db,
    sql,
    schema: buildSchema('pg'),
    close: () => sql.end({ timeout: 5 }),
  };
}
