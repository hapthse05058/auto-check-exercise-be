const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { createInlineQueue, safeTaskName } = require("../lib/taskQueue.js");

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("inline task queue (local dev)", () => {
  it("runs a named task once, however often it is enqueued", async () => {
    const seen = [];
    const queue = createInlineQueue({ handler: async (p) => seen.push(p.n) });
    assert.deepEqual(await queue.enqueue("write-j1-d1", { n: 1 }), {
      created: true,
    });
    assert.deepEqual(await queue.enqueue("write-j1-d1", { n: 2 }), {
      created: false,
    });
    await settle();
    assert.deepEqual(seen, [1]);
  });

  it("retries a task that throws, like Cloud Tasks would", async () => {
    let calls = 0;
    const queue = createInlineQueue({
      baseDelayMs: 1,
      handler: async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
      },
    });
    await queue.enqueue("t", {});
    await settle();
    assert.equal(calls, 3);
  });
});

describe("task names", () => {
  it("keeps only the characters Cloud Tasks accepts", () => {
    assert.equal(safeTaskName("write-abc-1A_b"), "write-abc-1A_b");
    assert.equal(safeTaskName("write/a b.c"), "write_a_b_c");
  });
});
