/**
 * The left indent of each table in a Google Docs tab. The Docs API does not
 * expose it, but the review table the IELTS template update adds must start
 * where the writing table above it starts (lib/doc/ieltsDoc.js
 * reviewTableRequests) — and the lessons' writing tables are often indented
 * (28–33 pt). The doc's HTML export carries it, as each table's margin-left.
 *
 * The export endpoint is the browser's, not an API: it allows a few requests
 * then about one every 10 s (429 in between). So exports run one at a time,
 * and a 429 waits and tries again; callers measure a lesson once and reuse it
 * (gradingJobs.updateTemplates), and fall back to no indent on null.
 */

const EXPORT_URL = "https://docs.google.com/document/d";
const RETRY_WAIT_MS = 11000;
const MAX_TRIES = 4;

/**
 * margin-left (pt) of every table of an exported HTML page, in document
 * order; 0 for a table without one.
 */
function parseTableIndents(html) {
  const css = {};
  for (const m of String(html).matchAll(/\.(c\d+)\{([^}]*)\}/g)) {
    css[m[1]] = m[2];
  }
  return [...String(html).matchAll(/<table([^>]*)>/g)].map((m) => {
    const classes = (/class="([^"]*)"/.exec(m[1]) || [])[1] || "";
    const inline = (/style="([^"]*)"/.exec(m[1]) || [])[1] || "";
    for (const rule of [inline, ...classes.split(/\s+/).map((c) => css[c])]) {
      const margin = /(?:^|;)\s*margin-left:\s*(-?[\d.]+)pt/.exec(rule || "");
      if (margin) return Number(margin[1]);
    }
    return 0;
  });
}

/**
 * @param deps.getToken  () => Promise<string> a token that may read the doc
 * @param deps.fetchImpl fetch, injectable for tests
 * @param deps.sleep     (ms) => Promise, injectable for tests
 * @returns {{indentsOf: (docId, tabId) => Promise<number[] | null>}} null
 *   when the export cannot be had.
 */
function createTableIndents({
  getToken,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let queue = Promise.resolve();

  async function exportTab(docId, tabId) {
    const url =
      `${EXPORT_URL}/${encodeURIComponent(docId)}/export?format=html` +
      `&tab=${encodeURIComponent(tabId)}`;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${await getToken()}` },
      });
      if (response.ok) return parseTableIndents(await response.text());
      await response.arrayBuffer?.().catch(() => {});
      if (response.status !== 429 || attempt === MAX_TRIES) {
        console.warn(
          `[TABLE-INDENTS] ${docId} ${tabId}: export ${response.status}`,
        );
        return null;
      }
      await sleep(RETRY_WAIT_MS);
    }
    return null;
  }

  function indentsOf(docId, tabId) {
    const run = queue.then(() => exportTab(docId, tabId));
    queue = run.catch(() => {});
    return run.catch((err) => {
      console.warn(`[TABLE-INDENTS] ${docId} ${tabId}: ${err.message}`);
      return null;
    });
  }

  return { indentsOf };
}

module.exports = { createTableIndents, parseTableIndents };
