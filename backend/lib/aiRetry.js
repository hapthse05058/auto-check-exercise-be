/**
 * Retrying and pacing calls to the AI provider. Pure — no Express, no
 * Firestore — so it is tested directly (tests/aiRetry.test.js).
 *
 * Why it exists: a grading run sends its items to the AI in groups, and a
 * group whose call failed used to be dropped after one attempt. A dropped
 * group is a set of students' answers written back with no feedback, in a job
 * that still says "done". The failures seen in production were all of the
 * kind that goes away on its own: the provider's 429 ("too many requests …
 * concurrency limit") and a connection cut mid-response ("terminated").
 */

/** Waits before the 2nd, 3rd and 4th attempt. */
const DEFAULT_DELAYS_MS = [3000, 10000, 30000];

/**
 * True for a failure worth trying again: rate limiting, a timeout, a provider
 * 5xx, or a call that never got an HTTP answer (reset, "terminated", DNS).
 *
 * False for an answer that will be the same next time — 400 (bad request),
 * 401/403 (key), 402 (no balance), 404 (model), 422.
 */
function isTransientAiError(err) {
  const status = Number(
    err?.status ?? err?.statusCode ?? err?.response?.status,
  );
  if (!Number.isFinite(status) || status === 0) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Runs `fn`, trying again after a transient failure — at most
 * `delays.length` more times. Any other error, and the last transient one, is
 * thrown as it is.
 *
 * @param {() => Promise<T>} fn
 * @param {{delays?: number[], sleep?: (ms: number) => Promise<void>,
 *          random?: () => number,
 *          onRetry?: (err: Error, attempt: number, waitMs: number) => void}} [options]
 *   `attempt` is the number of the attempt that just failed, from 1.
 * @returns {Promise<T>}
 */
async function withRetry(
  fn,
  {
    delays = DEFAULT_DELAYS_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    onRetry,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = delays[attempt - 1];
      if (delay === undefined || !isTransientAiError(err)) throw err;
      // Up to +50%, so groups that failed together do not come back together.
      const waitMs = Math.round(delay * (1 + random() * 0.5));
      onRetry?.(err, attempt, waitMs);
      await sleep(waitMs);
    }
  }
}

/**
 * At most `max` calls in flight at once; the rest wait their turn, first come
 * first served. One limiter is shared by every caller of the same provider
 * account, because the provider counts the account's requests, not ours per
 * job: two jobs of 4 groups each are 8 requests to it.
 *
 * @param {number} max
 * @returns {<T>(fn: () => Promise<T>) => Promise<T>}
 */
function createLimiter(max) {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let active = 0;
  const waiting = [];
  const release = () => {
    // Hand the slot straight to the next in line: freeing it first would let
    // a newcomer take it before the waiter wakes up, and run one too many.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async function run(fn) {
    if (active >= limit) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

module.exports = {
  DEFAULT_DELAYS_MS,
  createLimiter,
  isTransientAiError,
  withRetry,
};
