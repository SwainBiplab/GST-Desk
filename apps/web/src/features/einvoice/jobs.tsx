import { EinvoiceRepo, GstrRepo, onChange, type Ctx, type Database } from '@gst/db';
import { useEffect } from 'react';

import { clientFor, onSessionChange, savePractice } from './session';

import { useAppDb } from '@/app/db';

const TICK = 60_000;

/**
 * Send what is waiting in the GSP queue: once the app opens, whenever a request is added, when the
 * connection comes back, and every minute (for retries that are due). Nothing is sent while the
 * credentials are locked: the requests wait and keep their attempts.
 */
export async function drainQueue(database: Database, ctx: Ctx): Promise<void> {
  const repo = new EinvoiceRepo(database);
  const waiting = (await repo.jobsOf(ctx, null)).some(
    (j) => j['status'] === 'queued' || j['status'] === 'running',
  );
  if (!waiting) return;
  const cfg = await repo.gspConfig(ctx);
  const { gstin } = await new GstrRepo(database).businessInfo(ctx);
  const made = clientFor(database, ctx, cfg, gstin);
  if (!made) return;
  try {
    await repo.process(ctx, made.client, { link: made.link });
  } finally {
    if (cfg.mode === 'practice') savePractice(ctx.businessId);
  }
}

/** The runner, mounted once at the root of the app. */
export function GspJobs() {
  const { database, ctx } = useAppDb();
  useEffect(() => {
    if (!database || !ctx) return;
    let stopped = false;
    let busy = false;
    let again = false;
    const run = async () => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          await drainQueue(database, ctx);
        } while (again && !stopped);
      } catch (e) {
        console.warn('GSP queue failed', e);
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void run(), 1500);
    const every = setInterval(() => void run(), TICK);
    const online = () => void run();
    window.addEventListener('online', online);
    const off = onChange(database, (tables) => {
      if (tables.has('gsp_jobs')) void run();
    });
    const offSession = onSessionChange(() => void run());
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(every);
      window.removeEventListener('online', online);
      off();
      offSession();
    };
  }, [database, ctx]);
  return null;
}
