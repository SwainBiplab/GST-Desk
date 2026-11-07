import { getAuthTables } from 'better-auth/db';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { makeAuth } from '../src/auth/auth';
import * as schema from '../src/auth/schema';

/**
 * The hand-written Drizzle schema must carry every field better-auth 1.7 expects for the plugins we
 * use; a field added by a plugin upgrade shows up here before it fails in production.
 */
describe('the auth schema', () => {
  it('has every table and field the library asks for', () => {
    const auth = makeAuth({
      db: {},
      secret: 'x'.repeat(32),
      baseUrl: 'http://localhost:8787',
      otp: { send: async () => undefined },
      trustedOrigins: [],
      mirror: null,
    });
    const tables = getAuthTables(
      (auth as unknown as { options: Parameters<typeof getAuthTables>[0] }).options,
    );
    const missing: string[] = [];
    for (const [key, t] of Object.entries(tables)) {
      const table = (schema as Record<string, unknown>)[key];
      if (!table) {
        missing.push(`table ${key}`);
        continue;
      }
      const cols = getTableColumns(table as never) as Record<string, unknown>;
      for (const field of Object.keys(t.fields))
        if (!(field in cols)) missing.push(`${key}.${field}`);
      if (!('id' in cols)) missing.push(`${key}.id`);
    }
    expect(missing).toEqual([]);
  });
});
