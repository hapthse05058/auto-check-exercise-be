const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  createTableIndents,
  parseTableIndents,
} = require("../lib/docTableIndents.js");

// What the Docs HTML export looks like around tables.
const HTML =
  "<style>.c3{margin-left:28.3pt;border-spacing:0}.c5{border-spacing:0}" +
  ".c7{margin-left:-5.4pt}</style><body>" +
  '<table class="c5"><tr><td>Intro:</td></tr></table>' +
  '<table class="c3 c9"><tr><td>Bài chữa 1</td></tr></table>' +
  '<table class="c7"></table><table></table></body>';

const response = (status, body = "") => ({
  ok: status === 200,
  status,
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(0),
});

describe("table indents from the doc's HTML export", () => {
  it("reads each table's margin-left in order, 0 without one", () => {
    assert.deepEqual(parseTableIndents(HTML), [0, 28.3, -5.4, 0]);
  });

  it("exports the tab with the token, one at a time, waiting out a 429", async () => {
    const urls = [];
    const waits = [];
    let active = 0;
    let most = 0;
    const replies = [response(429), response(200, HTML), response(200, HTML)];
    const { indentsOf } = createTableIndents({
      getToken: async () => "sa",
      sleep: async (ms) => waits.push(ms),
      fetchImpl: async (url, init) => {
        assert.equal(init.headers.Authorization, "Bearer sa");
        urls.push(url);
        active += 1;
        most = Math.max(most, active);
        await new Promise((r) => setImmediate(r));
        active -= 1;
        return replies.shift();
      },
    });
    const [a, b] = await Promise.all([
      indentsOf("docA", "t.1"),
      indentsOf("docB", "t.2"),
    ]);
    assert.deepEqual(a, [0, 28.3, -5.4, 0]);
    assert.deepEqual(b, [0, 28.3, -5.4, 0]);
    assert.equal(most, 1);
    assert.equal(waits.length, 1);
    assert.match(urls[0], /\/document\/d\/docA\/export\?format=html&tab=t\.1$/);
  });

  it("null when the export keeps failing", async () => {
    const { indentsOf } = createTableIndents({
      getToken: async () => "sa",
      sleep: async () => {},
      fetchImpl: async () => response(403),
    });
    assert.equal(await indentsOf("docA", "t.1"), null);
  });
});
