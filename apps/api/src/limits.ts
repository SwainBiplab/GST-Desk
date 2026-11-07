/**
 * Rate limits: a token bucket per address for everyone, and a larger one per organisation once a
 * request is signed in. In-memory per process by default; Redis-backed when a client is given, so
 * several API replicas share one view.
 */
import type Redis from 'ioredis';

export interface Limiter {
  /** Take one token for `key`; false when the bucket is empty. */
  take(key: string): Promise<{ ok: boolean; remaining: number; resetMs: number }>;
}

export class MemoryLimiter implements Limiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async take(key: string) {
    const now = this.clock();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    // refill at the per-minute rate, up to the bucket size
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.sweep(now);
    return {
      ok,
      remaining: Math.floor(b.tokens),
      resetMs: ok ? 0 : Math.ceil(((1 - b.tokens) / this.perMinute) * 60_000),
    };
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (now - b.at > 120_000) this.buckets.delete(k);
  }
}

/** Fixed one-minute windows in Redis: one INCR with an expiry per key and window. */
export class RedisLimiter implements Limiter {
  constructor(
    private readonly redis: Redis,
    private readonly perMinute: number,
    private readonly clock: () => number = Date.now,
  ) {}

  async take(key: string) {
    const now = this.clock();
    const window = Math.floor(now / 60_000);
    const k = `rl:${key}:${window}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.pexpire(k, 60_000);
    const ok = n <= this.perMinute;
    return {
      ok,
      remaining: Math.max(0, this.perMinute - n),
      resetMs: ok ? 0 : (window + 1) * 60_000 - now,
    };
  }
}
