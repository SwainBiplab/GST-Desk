/** Batches on the `ai` queue (prompt 48): one entry per batch and step, delayed a minute between polls. */
import type { Jobs } from '../jobs/queues';

import type { AiGatewayService } from './service';

export interface AiBatchJob {
  type: 'batch';
  orgId: string;
  batchId: string;
}

export function batchEnqueuer(jobs: Jobs | null) {
  if (!jobs) return null;
  return async (job: { orgId: string; batchId: string }, delayMs = 0): Promise<void> => {
    await jobs.queue('ai').add('batch', { type: 'batch', ...job } satisfies AiBatchJob, {
      jobId: `ai-batch:${job.batchId}:${Date.now()}`,
      delay: delayMs,
      attempts: 1,
    });
  };
}

export function startAiWorkers(jobs: Jobs, service: AiGatewayService): void {
  jobs.work<AiBatchJob>(
    'ai',
    async (job) => {
      if (job.data.type !== 'batch') return;
      await service.runBatch(job.data.orgId, job.data.batchId);
    },
    { concurrency: 2 },
  );
}
