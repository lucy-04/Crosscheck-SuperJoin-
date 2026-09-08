/**
 * Rate limiting for model calls, against BOTH limits providers actually enforce.
 *
 * This started as a requests-per-minute limiter, which was the wrong abstraction
 * and had to be measured to discover:
 *
 *   Gemini free tier   the binding limit is REQUESTS (20/day). Page-level
 *                      chunking cut the corpus from ~3,250 calls to ~510.
 *   Groq free tier     the binding limit is TOKENS (8,000/minute) with requests
 *                      effectively unlimited at 1,000/minute. Chunking changes
 *                      nothing here: total tokens are what they are.
 *
 * So both are enforced. A token bucket refills continuously at the permitted
 * rate, and a request waits until the corpus of tokens it is about to spend fits
 * within the budget. Pacing beneath the limit turns a retry storm — where every
 * rejected call is retried and the retries collide — into steady throughput.
 */

export interface LimitConfig {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export class RateLimiter {
  private requestTimes: number[] = [];
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly config: LimitConfig) {
    this.tokens = config.tokensPerMinute;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMinutes = (now - this.lastRefill) / 60_000;
    this.lastRefill = now;
    this.tokens = Math.min(
      this.config.tokensPerMinute,
      this.tokens + elapsedMinutes * this.config.tokensPerMinute,
    );
  }

  /**
   * Wait until `estimatedTokens` may be spent without breaching either limit.
   *
   * A single request larger than the whole per-minute budget would otherwise wait
   * forever, so it is allowed through once the bucket is full — the provider will
   * reject it if it genuinely cannot be served, which is information we want
   * rather than a deadlock.
   */
  async acquire(estimatedTokens: number, signal?: AbortSignal): Promise<void> {
    const want = Math.min(estimatedTokens, this.config.tokensPerMinute);

    for (;;) {
      signal?.throwIfAborted();
      this.refill();

      const now = Date.now();
      this.requestTimes = this.requestTimes.filter((t) => now - t < 60_000);

      const requestsOk = this.requestTimes.length < this.config.requestsPerMinute;
      const tokensOk = this.tokens >= want;

      if (requestsOk && tokensOk) {
        this.requestTimes.push(now);
        this.tokens -= want;
        return;
      }

      const waitForTokens = tokensOk
        ? 0
        : ((want - this.tokens) / this.config.tokensPerMinute) * 60_000;
      const waitForRequests = requestsOk ? 0 : 60_000 - (now - this.requestTimes[0]);
      const waitMs = Math.max(250, Math.ceil(Math.max(waitForTokens, waitForRequests)) + 50);

      await sleep(waitMs, signal);
    }
  }

  /** Give back tokens that a failed call never actually spent. */
  refund(tokens: number): void {
    this.tokens = Math.min(this.config.tokensPerMinute, this.tokens + tokens);
  }

  /** Drain the bucket, e.g. after the provider says to wait. */
  penalise(seconds: number): void {
    this.tokens = Math.max(0, this.tokens - (seconds / 60) * this.config.tokensPerMinute);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Providers say how long to wait ("Please try again in 18.135s"). Obeying that is
 * strictly better than a guessed exponential backoff, which either wastes time or
 * retries too early and burns another slot.
 */
export function retryAfterSeconds(message: string): number | null {
  const m = message.match(/try again in ([\d.]+)\s*s/i) ?? message.match(/retry in ([\d.]+)\s*s/i);
  if (m) return parseFloat(m[1]);
  const ms = message.match(/try again in ([\d.]+)\s*ms/i);
  if (ms) return parseFloat(ms[1]) / 1000;
  return null;
}

/**
 * Rough token cost of a request, for budgeting.
 *
 * Counts the RESERVED output budget rather than expected output, because that is
 * what providers charge against a tokens-per-minute limit — measured directly
 * against Groq, which reported "Requested: 5192" for a call whose input was only
 * about 1,600 tokens.
 */
export function estimateTokens(text: string, reservedOutput = 1800): number {
  return Math.ceil(text.length / 4) + reservedOutput;
}

let shared: RateLimiter | null = null;
let sharedKey = "";

/** The process-wide limiter, so every call site shares one budget. */
export function getRateLimiter(config: LimitConfig): RateLimiter {
  const key = `${config.requestsPerMinute}/${config.tokensPerMinute}`;
  if (!shared || sharedKey !== key) {
    shared = new RateLimiter(config);
    sharedKey = key;
  }
  return shared;
}
