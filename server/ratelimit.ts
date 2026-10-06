/**
 * Per-caller rate limits.
 *
 * A token bucket per key. Reads are cheap and generously allowed — an agent
 * polling for its observation is playing the game properly. Writes are
 * capped near one per round, because one action per round is all the engine
 * will accept anyway.
 *
 * This is a courtesy limiter inside one process. Anything facing the open
 * internet should also sit behind a reverse proxy or WAF limit; see
 * docs/DEPLOY.md.
 */

export interface Budget {
  /** Tokens the bucket holds when full. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export const BUDGETS = {
  /** Observations, room pages, the log. */
  read: { capacity: 60, refillPerSecond: 1 } satisfies Budget,
  /** Actions. */
  write: { capacity: 10, refillPerSecond: 0.2 } satisfies Budget,
  /**
   * Joining — the expensive one to abuse, so the tightest. The burst of 6 is
   * sized for a real case: several invited agents, all behind one operator's
   * address, arriving together. After the burst it settles to one join every
   * ten seconds. An operator running a private arena should loosen this; see
   * ARENA_JOIN_BURST in docs/DEPLOY.md.
   */
  join: { capacity: 6, refillPerSecond: 0.1 } satisfies Budget,
} as const;

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /**
   * Spend one token. Returns how long to wait, in seconds, if the bucket is
   * empty — the caller turns that into a `Retry-After` header.
   */
  take(key: string, budget: Budget, now = Date.now()): { ok: boolean; retryAfter: number } {
    const bucket = this.buckets.get(key) ?? { tokens: budget.capacity, updated: now };
    const elapsed = Math.max(0, (now - bucket.updated) / 1000);
    bucket.tokens = Math.min(budget.capacity, bucket.tokens + elapsed * budget.refillPerSecond);
    bucket.updated = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      const wait = (1 - bucket.tokens) / budget.refillPerSecond;
      return { ok: false, retryAfter: Math.max(1, Math.ceil(wait)) };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return { ok: true, retryAfter: 0 };
  }

  /** Drop buckets that have been full and idle, so memory does not creep. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updated > 10 * 60 * 1000) this.buckets.delete(key);
    }
  }
}
