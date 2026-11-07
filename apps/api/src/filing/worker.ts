/**
 * The queue side of GST filing (prompt 46): `gsp` jobs run one filing job each (a push that is still being
 * processed comes back after a delay), and a repeating job asks the portal about returns that are saved or
 * exported but not filed, so an ARN lands in the desk without anyone pressing a button.
 */
import type { Logger } from 'pino';

import type { Jobs } from '../jobs/queues';

import type { FilingService } from './service';

export const SCAN_EVERY_MS = 30 * 60_000;
type GspJob = { type: 'run'; orgId: string; jobId: string } | { type: 'scan' };

export function filingEnqueuer(jobs: Jobs | null) {
  return async (job: { orgId: string; jobId: string }, delayMs = 0): Promise<void> => {
    // one queue entry per job and attempt window: a second click does not run a push twice
    await jobs?.queue('gsp').add(
      'run',
      { type: 'run', ...job },
      {
        jobId: `filing:${job.jobId}:${delayMs > 0 ? 'later' : 'now'}`,
        delay: delayMs,
        attempts: 1,
      },
    );
  };
}

export async function startFilingWorkers(
  jobs: Jobs,
  service: FilingService,
  log: Logger,
): Promise<void> {
  jobs.work<GspJob>(
    'gsp',
    async (job) => {
      if (job.data.type === 'scan') {
        const r = await service.scan();
        log.info(r, 'filing scan');
        return;
      }
      await service.run(job.data.orgId, job.data.jobId);
    },
    { concurrency: 2 },
  );
  await jobs
    .queue('gsp')
    .upsertJobScheduler(
      'filing-scan',
      { every: SCAN_EVERY_MS },
      { name: 'scan', data: { type: 'scan' } },
    );
}
