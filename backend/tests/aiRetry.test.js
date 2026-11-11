const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  DEFAULT_DELAYS_MS,
  createLimiter,
  isTransientAiError,
  withRetry,
} = require("../lib/aiRetry.js");

const httpError = (status, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

describe("isTransientAiError", () => {
  it("retries rate limiting, timeouts and provider errors", () => {
    for (const status of [408, 409, 429, 500, 502, 503, 504]) {
      assert.equal(isTransientAiError(httpError(status)), true, `${status}`);
    }
  });

  it("retries a call that never got an HTTP answer", () => {
    // What undici throws when the provider cuts the stream mid-response.
    assert.equal(isTransientAiError(new TypeError("terminated")), true);
    assert.equal(isTransientAiError(new Error("ECONNRESET")), true);
    assert.equal(isTransientAiError(httpError(0)), true);
  });

  it("does not retry an answer that will not change", () => {
    for (const status of [400, 401, 402, 403, 404, 422]) {
      assert.equal(isTransientAiError(httpError(status)), false, `${status}`);
    }
  });
});

describe("withRetry", () => {
  const recorder = () => {
    const waits = [];
    return {
      waits,
      options: {
        sleep: async (ms) => waits.push(ms),
        random: () => 0,
      },
    };
  };

  it("returns the first success without waiting", async () => {
    const { waits, options } = recorder();
    assert.equal(await withRetry(async () => "ok", options), "ok");
    assert.deepEqual(waits, []);
  });

  it("tries again after a 429 and returns the later success", async () => {
    const { waits, options } = recorder();
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw httpError(429);
      return "graded";
    }, options);
    assert.equal(result, "graded");
    assert.equal(calls, 3);
    assert.deepEqual(waits, DEFAULT_DELAYS_MS.slice(0, 2));
  });

  it("gives up after the last delay and throws the provider's error", async () => {
    const { waits, options } = recorder();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw httpError(429, "Too many requests");
      }, options),
      /Too many requests/,
    );
    assert.equal(calls, DEFAULT_DELAYS_MS.length + 1);
    assert.deepEqual(waits, DEFAULT_DELAYS_MS);
  });

  it("does not retry a permanent failure", async () => {
    const { waits, options } = recorder();
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw httpError(402, "Insufficient Balance");
      }, options),
      /Insufficient Balance/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });

  it("spreads the waits by up to half and reports each retry", async () => {
    const waits = [];
    const seen = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new TypeError("terminated");
      },
      {
        delays: [1000],
        sleep: async (ms) => waits.push(ms),
        random: () => 1,
        onRetry: (err, attempt, waitMs) =>
          seen.push([err.message, attempt, waitMs]),
      },
    );
    assert.deepEqual(waits, [1500]);
    assert.deepEqual(seen, [["terminated", 1, 1500]]);
  });
});

describe("createLimiter", () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("never runs more than `max` at once, and runs everything", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const done = [];
    const gates = [];
    const task = (n) =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => gates.push(resolve));
        active -= 1;
        done.push(n);
        return n;
      });
    const all = Promise.all([1, 2, 3, 4, 5].map(task));
    while (done.length < 5) {
      await tick();
      const open = gates.shift();
      if (open) open();
    }
    assert.deepEqual(await all, [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.equal(active, 0);
  });

  it("gives a freed slot to the one waiting, not to a newcomer", async () => {
    const limit = createLimiter(1);
    const order = [];
    let openFirst;
    const first = limit(
      () =>
        new Promise((resolve) => {
          openFirst = resolve;
        }),
    );
    const second = limit(async () => order.push("second"));
    await tick();
    openFirst();
    // Arrives in the same turn the slot is freed.
    const third = limit(async () => order.push("third"));
    await Promise.all([first, second, third]);
    assert.deepEqual(order, ["second", "third"]);
  });

  it("frees the slot when a task throws", async () => {
    const limit = createLimiter(1);
    await assert.rejects(
      limit(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await limit(async () => "next"), "next");
  });
});
