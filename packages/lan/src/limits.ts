/** A token bucket per key: `rate` requests a second on average, bursts of up to `burst`. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {}

  /** True when the request may go ahead. */
  allow(key: string, now: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000)
      for (const [k, v] of this.buckets) if (now - v.at > 600_000) this.buckets.delete(k);
    return ok;
  }
}
