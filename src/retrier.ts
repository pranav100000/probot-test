/**
 * Generic bounded retrier — the un-minified shape of the `Jt` class in the
 * production stack trace (`new Jt(async () => {...}, { maxRetries })`).
 *
 * It runs an async task and retries it on *retryable* failures up to
 * `maxRetries` times, with caller-controlled backoff. A task that throws a
 * non-retryable error fails fast. This primitive deliberately knows nothing
 * about HTTP — the connection manager supplies the `isRetryable` policy.
 */

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetrierOptions {
  /** Maximum *additional* attempts after the first. Total tries = maxRetries + 1. */
  readonly maxRetries: number;
  /** Decide whether a thrown error is worth retrying. */
  readonly isRetryable: (error: unknown, attempt: number) => boolean;
  /** Backoff before the next attempt (attempt is 1-based: delay before retry #attempt). */
  readonly backoffMs?: (attempt: number, error: unknown) => number;
  /** Injectable sleep so tests can advance without real timers. */
  readonly sleep?: SleepFn;
  /** Aborts pending sleeps and stops further attempts. */
  readonly signal?: AbortSignal | undefined;
}

export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const DEFAULT_BACKOFF = (attempt: number): number => Math.min(30_000, 250 * 2 ** (attempt - 1));

export class Retrier<T> {
  private readonly opts: RetrierOptions;

  constructor(
    private readonly task: (attempt: number) => Promise<T>,
    opts: RetrierOptions
  ) {
    this.opts = opts;
  }

  async run(): Promise<T> {
    const sleep = this.opts.sleep ?? defaultSleep;
    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF;
    const maxRetries = Math.max(0, this.opts.maxRetries);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt += 1;
      try {
        return await this.task(attempt);
      } catch (error) {
        const retriesUsed = attempt - 1;
        const canRetry =
          retriesUsed < maxRetries &&
          !this.opts.signal?.aborted &&
          this.opts.isRetryable(error, attempt);
        if (!canRetry) {
          throw error;
        }
        await sleep(Math.max(0, backoff(attempt, error)), this.opts.signal);
      }
    }
  }
}
