/** Export packs on the `pdf` queue (prompt 47): one entry per pack, run once. */
import type { Jobs } from '../jobs/queues';

import type { ExportPackService } from './export-pack';

export interface PackJob {
  type: 'export_pack';
  orgId: string;
  packId: string;
}

export function packEnqueuer(jobs: Jobs | null) {
  if (!jobs) return null;
  return async (job: { orgId: string; packId: string }): Promise<void> => {
    await jobs.queue('pdf').add('export_pack', { type: 'export_pack', ...job } satisfies PackJob, {
      jobId: `pack:${job.packId}`,
      attempts: 1,
    });
  };
}

export function startPackWorkers(jobs: Jobs, service: ExportPackService): void {
  jobs.work<PackJob>(
    'pdf',
    async (job) => {
      if (job.data.type !== 'export_pack') return;
      await service.run(job.data.orgId, job.data.packId);
    },
    { concurrency: 1 },
  );
}
