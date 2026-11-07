/**
 * Background work on BullMQ: one queue per kind, retries with exponential backoff, and a dead-letter
 * queue that keeps a job whose attempts ran out so a person can look at it and retry. Workers are
 * registered by the features that own them; this file is the plumbing.
 */
import { Queue, QueueEvents, Worker, type Job, type JobsOptions, type Processor } from 'bullmq';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

export const QUEUES = ['recurring', 'dispatch', 'gsp', 'ai', 'pdf'] as const;
export type QueueName = (typeof QUEUES)[number];
export const DEAD_QUEUE = 'dead';

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { count: 1_000, age: 7 * 24 * 3600 },
  removeOnFail: false,
};

export interface DeadLetter {
  queue: QueueName;
  name: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  orgId: string | null;
  diedAt: number;
}

export interface Jobs {
  queue(name: QueueName): Queue;
  dead: Queue<DeadLetter>;
  /** Start a worker for a queue; a job that fails its last attempt is copied to the dead queue. */
  work<T>(name: QueueName, processor: Processor<T>, opts?: { concurrency?: number }): Worker<T>;
  /** Put a dead job back on its queue. */
  retryDead(deadJobId: string): Promise<boolean>;
  counts(): Promise<
    Record<
      string,
      { waiting: number; active: number; failed: number; delayed: number; dead: number }
    >
  >;
  close(): Promise<void>;
}

export function makeJobs(redis: Redis, log: Logger, opts: { prefix?: string } = {}): Jobs {
  const connection = redis;
  const prefix = opts.prefix ?? 'gst';
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];
  const events: QueueEvents[] = [];
  const dead = new Queue<DeadLetter>(DEAD_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: { attempts: 1, removeOnComplete: false, removeOnFail: false },
  });

  const queue = (name: QueueName): Queue => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      queues.set(name, q);
    }
    return q;
  };

  return {
    queue,
    dead,
    work<T>(name: QueueName, processor: Processor<T>, o: { concurrency?: number } = {}) {
      const w = new Worker<T>(name, processor, {
        connection,
        prefix,
        concurrency: o.concurrency ?? 2,
      });
      w.on('failed', (job: Job<T> | undefined, err: Error) => {
        if (!job) return;
        const last = job.attemptsMade >= (job.opts.attempts ?? 1);
        log.warn(
          { queue: name, job: job.id, attempt: job.attemptsMade, last, err: err.message },
          'job failed',
        );
        if (last) {
          void dead.add('dead', {
            queue: name,
            name: job.name,
            data: job.data,
            failedReason: err.message,
            attemptsMade: job.attemptsMade,
            orgId: (job.data as { orgId?: string } | null)?.orgId ?? null,
            diedAt: Date.now(),
          });
        }
      });
      workers.push(w as Worker);
      return w;
    },
    async retryDead(deadJobId) {
      const d = await dead.getJob(deadJobId);
      if (!d) return false;
      await queue(d.data.queue).add(d.data.name, d.data.data);
      await d.remove();
      return true;
    },
    async counts() {
      const out: Record<
        string,
        { waiting: number; active: number; failed: number; delayed: number; dead: number }
      > = {};
      const deadJobs = await dead.getJobs(['waiting', 'delayed', 'completed', 'failed'], 0, 10_000);
      for (const name of QUEUES) {
        const c = await queue(name).getJobCounts('waiting', 'active', 'failed', 'delayed');
        out[name] = {
          waiting: c['waiting'] ?? 0,
          active: c['active'] ?? 0,
          failed: c['failed'] ?? 0,
          delayed: c['delayed'] ?? 0,
          dead: deadJobs.filter((j) => j.data.queue === name).length,
        };
      }
      return out;
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(events.map((e) => e.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      await dead.close();
    },
  };
}
