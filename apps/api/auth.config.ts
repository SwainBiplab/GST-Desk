/**
 * For the better-auth CLI (`pnpm exec better-auth generate`): builds the auth instance over a lazy
 * connection so the CLI can read the plugins and write `src/auth/schema.ts`. Never used at runtime.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { makeAuth } from './src/auth/auth';

const client = postgres('postgres://cli:cli@127.0.0.1:1/cli', { max: 1 });
export const auth = makeAuth({
  db: drizzle(client),
  secret: 'development-only-'.padEnd(32, 'x'),
  baseUrl: 'http://localhost:8787',
  otp: { send: async () => undefined },
  trustedOrigins: [],
  mirror: null,
});
