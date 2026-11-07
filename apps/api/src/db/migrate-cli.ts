/** `pnpm --filter api db:migrate`: migrate the database named by DATABASE_URL (the owner's connection). */
import { loadConfig } from '../config';

import { migrateApi } from './migrate';
import { openPostgres } from './pool';

const cfg = loadConfig(process.env);
const d = openPostgres(cfg.databaseUrl, { max: 2, appName: 'gst-api-migrate' });
try {
  const r = await migrateApi(d, { appPassword: cfg.appDbPassword });
  console.log(
    `shared migrations applied: ${r.shared}; api migrations applied: ${r.api.join(', ') || 'none'}`,
  );
} finally {
  await d.close();
}
