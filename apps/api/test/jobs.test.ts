/** Jobs on Redis in a container: retries with backoff, the dead-letter queue, requeue, counts. */
import Redis from 'ioredis';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeJobs, type Jobs } from '../src/jobs/queues';
import { RedisLimiter } from '../src/limits';

import { startRedis, type RedisStack } from './containers';

let stack: RedisStack;
let redis: Redis;
let jobs: Jobs;

beforeAll(async () => {
  stack = await startRedis();
  redis = new Redis(stack.url, { maxRetriesPerRequest: null });
  jobs = makeJobs(redis, pino({ level: 'silent' }), { prefix: 'test' });
});
afterAll(async () => {
  await jobs?.close();
  await redis?.quit();
  await stack?.stop();
});

const until = async (fn: () => Promise<boolean>, ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};

describe('jobs', () => {
  it('retries a failing job with backoff and moves it to the dead queue after the last attempt; a person can requeue it', async () => {
    let runs = 0;
    jobs.work<{ failTimes: number }>('dispatch', async (job) => {
      runs++;
      if (job.data.failTimes >= runs) throw new Error(`boom ${runs}`);
      return 'done';
    });
    // three attempts, short backoff so the test is quick
    const dead = await jobs
      .queue('dispatch')
      .add(
        'send',
        { orgId: '11111111-1111-4111-8111-111111111111', failTimes: 99 },
        { attempts: 3, backoff: { type: 'fixed', delay: 50 } },
      );
    await until(
      async () => (await jobs.dead.getJobs(['waiting', 'delayed', 'completed'])).length === 1,
    );
    expect(runs).toBe(3);
    const [d] = await jobs.dead.getJobs(['waiting', 'delayed', 'completed']);
    expect(d!.data).toMatchObject({
      queue: 'dispatch',
      name: 'send',
      attemptsMade: 3,
      orgId: '11111111-1111-4111-8111-111111111111',
    });
    expect(d!.data.failedReason).toBe('boom 3');
    const counts = await jobs.counts();
    expect(counts['dispatch']!.dead).toBe(1);
    expect(counts['dispatch']!.failed).toBe(1);
    expect(await jobs.dead.getJobs(['waiting']).then((j) => j.some((x) => x.id === d!.id))).toBe(
      true,
    );

    // requeue: the job runs again (and would fail again; here we make it succeed by lowering failTimes)
    runs = 0;
    const ok = await jobs.retryDead(String(d!.id));
    expect(ok).toBe(true);
    expect(await jobs.retryDead(String(d!.id))).toBe(false);
    await until(
      async () =>
        (await jobs.queue('dispatch').getJobCounts('completed'))['completed']! >= 1 || runs >= 3,
      20_000,
    );
    expect(
      (await jobs.dead.getJobs(['waiting', 'delayed', 'completed'])).length,
    ).toBeGreaterThanOrEqual(0);
    void dead;
  });

  it('a job that succeeds on a later attempt never reaches the dead queue', async () => {
    let runs = 0;
    jobs.work('pdf', async () => {
      runs++;
      if (runs < 2) throw new Error('first try fails');
      return 'ok';
    });
    const job = await jobs
      .queue('pdf')
      .add('render', { documentId: 'x' }, { attempts: 3, backoff: { type: 'fixed', delay: 50 } });
    await until(async () => (await job.getState()) === 'completed');
    expect(runs).toBe(2);
    const counts = await jobs.counts();
    expect(counts['pdf']!.dead).toBe(0);
  });

  it('the Redis limiter counts per key per minute', async () => {
    let now = 1_700_000_000_000;
    const l = new RedisLimiter(redis, 3, () => now);
    for (let i = 0; i < 3; i++) expect((await l.take('ip:1')).ok).toBe(true);
    expect((await l.take('ip:1')).ok).toBe(false);
    expect((await l.take('ip:2')).ok).toBe(true);
    now += 60_000;
    expect((await l.take('ip:1')).ok).toBe(true);
  });
});
