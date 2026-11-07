/**
 * The queue side of dispatch (prompt 44): `dispatch` jobs deliver one message each, with the queue's
 * exponential backoff for a provider that is busy; a repeating job on the `recurring` queue runs the reminder
 * rules and the recurring-invoice scheduler every quarter hour.
 */
import type { Logger } from 'pino';

import type { Jobs } from '../jobs/queues';

import type { DispatchJob, MessagingService } from './service';

export const SCAN_EVERY_MS = 15 * 60_000;

export function enqueuer(jobs: Jobs | null): (job: DispatchJob, delayMs?: number) => Promise<void> {
  return async (job, delayMs = 0) => {
    // one job per message: a second approval or a double click does not queue a second delivery
    await jobs
      ?.queue('dispatch')
      .add(job.type, job, { jobId: `deliver:${job.messageId}`, delay: delayMs });
  };
}

export async function startMessagingWorkers(
  jobs: Jobs,
  service: MessagingService,
  log: Logger,
): Promise<void> {
  jobs.work<DispatchJob>('dispatch', async (job) => {
    if (job.data.type !== 'deliver') return;
    const r = await service.deliver(job.data.orgId, job.data.messageId);
    if (r === 'later') throw new Error('not before its time'); // retried with the queue's backoff
  });
  jobs.work<{ type: 'scan' }>(
    'recurring',
    async () => {
      const reminders = await service.runReminders();
      const recurring = await service.runRecurring();
      log.info({ ...reminders, ...recurring }, 'scheduled scan');
    },
    { concurrency: 1 },
  );
  await jobs
    .queue('recurring')
    .upsertJobScheduler(
      'messaging-scan',
      { every: SCAN_EVERY_MS },
      { name: 'scan', data: { type: 'scan' } },
    );
}
