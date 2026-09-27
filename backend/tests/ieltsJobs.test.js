/**
 * Grading jobs for an IELTS class (course gradingProfile "ielts"): the IELTS
 * template tables are read, graded by the IELTS grader (charts downloaded for
 * Task 1) and written into their own "GV chữa" cell — sharing the job's
 * leases, write-once rule and per-doc receipts with Basic.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DocsApiError } = require("../lib/googleDocsApi.js");
const { IeltsError } = require("../lib/ieltsWriting.js");
const {
  IELTS_FEEDBACK,
  createHarness,
  makeIeltsTab,
  makeTab,
} = require("./helpers/gradingHarness.js");

/** IELTS_FEEDBACK as the doc shows it: "**" became styling. */
const WRITTEN = IELTS_FEEDBACK.replaceAll("**", "");
const ESSAY = "Some people believe homework is useless. I disagree.";

const ielts = (tabs, options = {}) =>
  createHarness({ tabs, points: 10, gradingProfile: "ielts", ...options });

async function runJob(h) {
  const { jobId } = await h.start();
  await h.drain();
  return jobId;
}

const warningCodes = (h, jobId) =>
  Object.values(h.docRecords(jobId)).flatMap((d) =>
    (d.warnings || []).map((w) => w.code),
  );

describe("IELTS grading job", () => {
  it("writes the feedback into GV chữa and charges 1 point per doc", async () => {
    const h = ielts({
      docA: makeIeltsTab({ tables: [{ essay: ESSAY }] }),
      docB: makeIeltsTab({ tables: [{ essay: "Another essay." }] }),
    });
    const jobId = await runJob(h);

    assert.equal(h.job(jobId).gradingProfile, "ielts");
    assert.equal(h.job(jobId).written, 2);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA"), WRITTEN);
    assert.equal(h.docsApi.ieltsFeedbackOf("docB"), WRITTEN);
    assert.equal(h.points(), 8);
    assert.equal(h.ledger().length, 2);
    // Basic's grader is never asked; the IELTS one gets the text as written.
    assert.equal(h.counters.grade, 0);
    assert.equal(h.counters.ielts, 2);
    assert.deepEqual(
      h.counters.ieltsInputs.map((i) => [i.task, i.essay]).sort(),
      [
        ["task2", "Another essay."],
        ["task2", ESSAY],
      ],
    );
  });

  it("grades every IELTS table of a doc, each into its own cell", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [
          { title: "IELTS WRITING – ĐOẠN VĂN", essay: "Intro paragraph." },
          { essay: ESSAY },
        ],
      }),
    });
    await runJob(h);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA", 0), WRITTEN);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA", 1), WRITTEN);
    assert.deepEqual(h.counters.ieltsInputs.map((i) => i.task).sort(), [
      "paragraph",
      "task2",
    ]);
    assert.equal(h.points(), 9, "one doc, one point");
  });

  it("Task 1: downloads the charts of the prompt cell, in order, with the token", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [
          {
            title: "IELTS WRITING – TASK 1",
            images: ["c1", "c2"],
            essay: ESSAY,
          },
        ],
        objects: { c1: "https://img/1", c2: "https://img/2" },
      }),
    });
    await runJob(h);
    assert.deepEqual(
      h.counters.images.map((i) => i.uri),
      ["https://img/1", "https://img/2"],
    );
    assert.ok(h.counters.images.every((i) => i.token === "tok"));
    const [input] = h.counters.ieltsInputs;
    assert.equal(input.task, "task1");
    assert.deepEqual(
      input.images.map((img) => img.buffer.toString()),
      ["png:https://img/1", "png:https://img/2"],
    );
    assert.equal(h.docsApi.ieltsFeedbackOf("docA"), WRITTEN);
  });

  it("a paragraph about a chart sends its chart; one without a chart is graded as text", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [
          {
            title: "IELTS WRITING – ĐOẠN VĂN",
            images: ["c1"],
            essay: "Intro and overview.",
          },
          { title: "IELTS WRITING – ĐOẠN VĂN", essay: "A conclusion." },
        ],
        objects: { c1: "https://img/1" },
      }),
    });
    await runJob(h);
    assert.deepEqual(
      h.counters.images.map((i) => i.uri),
      ["https://img/1"],
    );
    const byEssay = Object.fromEntries(
      h.counters.ieltsInputs.map((i) => [
        i.essay,
        i.images.map((img) => img.buffer.toString()),
      ]),
    );
    assert.deepEqual(byEssay, {
      "Intro and overview.": ["png:https://img/1"],
      "A conclusion.": [],
    });
    assert.equal(h.docsApi.ieltsFeedbackOf("docA", 0), WRITTEN);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA", 1), WRITTEN);
  });

  it("Task 2 never downloads an image", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [{ images: ["c1"], essay: ESSAY }],
        objects: { c1: "https://img/1" },
      }),
    });
    await runJob(h);
    assert.equal(h.counters.images.length, 0);
    assert.deepEqual(h.counters.ieltsInputs[0].images, []);
  });

  it("Task 1 without a chart is not graded, not written, not charged", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [{ title: "IELTS WRITING – TASK 1", essay: ESSAY }],
      }),
    });
    const jobId = await runJob(h);
    assert.equal(h.counters.ielts, 0);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA"), "");
    assert.equal(h.points(), 10);
    assert.ok(warningCodes(h, jobId).includes("ieltsChartMissing"));
  });

  it("a chart that cannot be downloaded: warned, nothing written", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [
          { title: "IELTS WRITING – TASK 1", images: ["c1"], essay: ESSAY },
        ],
        objects: { c1: "https://img/1" },
      }),
    });
    h.hooks.imageFail = () => true;
    const jobId = await runJob(h);
    assert.equal(h.counters.ielts, 0);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA"), "");
    assert.equal(h.points(), 10);
    assert.ok(warningCodes(h, jobId).includes("ieltsChartMissing"));
  });

  it("more than 3 charts: warned, not graded", async () => {
    const ids = ["a", "b", "c", "d"];
    const h = ielts({
      docA: makeIeltsTab({
        tables: [
          { title: "IELTS WRITING – TASK 1", images: ids, essay: ESSAY },
        ],
        objects: Object.fromEntries(ids.map((id) => [id, `https://img/${id}`])),
      }),
    });
    const jobId = await runJob(h);
    assert.equal(h.counters.images.length, 0);
    assert.ok(warningCodes(h, jobId).includes("ieltsTooManyImages"));
  });

  it("the AI failing twice leaves that cell empty, the others are written", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [{ essay: "Bad one." }, { essay: ESSAY }],
      }),
    });
    h.hooks.ieltsFail = (input) =>
      input.essay === "Bad one."
        ? new IeltsError(502, "ielts_ai_invalid")
        : null;
    const jobId = await runJob(h);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA", 0), "");
    assert.equal(h.docsApi.ieltsFeedbackOf("docA", 1), WRITTEN);
    assert.ok(warningCodes(h, jobId).includes("ieltsAiInvalid"));
    assert.equal(h.points(), 9);
  });

  it("never writes over a filled GV chữa cell; a re-run charges nothing", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [{ essay: ESSAY, feedback: "Cô sẽ chữa tay" }],
      }),
      docB: makeIeltsTab({ tables: [{ essay: ESSAY }] }),
    });
    const first = await runJob(h);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA"), "Cô sẽ chữa tay");
    assert.equal(h.docRecords(first).docA.reason, "alreadyGraded");
    assert.equal(h.points(), 9);

    const second = await runJob(h);
    assert.equal(h.job(second).written, 0);
    assert.equal(h.job(second).notice, "allChecked");
    assert.equal(h.points(), 9);
  });

  it("write landed but its response was lost: billed once, not rewritten", async () => {
    const h = ielts({ docA: makeIeltsTab({ tables: [{ essay: ESSAY }] }) });
    h.docsApi.failNext("batchUpdate", new DocsApiError(0, "reset"), {
      docId: "docA",
      phase: "after",
    });
    const jobId = await runJob(h);
    assert.equal(h.docsApi.calls.applied, 1);
    assert.equal(h.docsApi.ieltsFeedbackOf("docA"), WRITTEN);
    assert.equal(h.points(), 9);
    assert.equal(h.job(jobId).charged, 1);
  });

  it("a refused write is not charged", async () => {
    const h = ielts({ docA: makeIeltsTab({ tables: [{ essay: ESSAY }] }) });
    h.docsApi.failNext("batchUpdate", new DocsApiError(403, "no access"), {
      docId: "docA",
    });
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).failed, 1);
    assert.equal(h.points(), 10);
    assert.equal(h.ledger().length, 0);
  });

  it("an IELTS doc without the template is reported, not guessed at", async () => {
    const h = ielts({ docA: makeTab({ answers: ["I done it"] }) });
    const jobId = await runJob(h);
    assert.equal(h.counters.ielts, 0);
    assert.equal(h.docRecords(jobId).docA.reason, "noTable");
  });

  it("counts submissions without downloading any chart", async () => {
    const h = ielts({
      docA: makeIeltsTab({
        tables: [
          { title: "IELTS WRITING – TASK 1", images: ["c1"], essay: ESSAY },
        ],
        objects: { c1: "https://img/1" },
      }),
      docB: makeIeltsTab({ tables: [{ essay: ESSAY, feedback: "done" }] }),
    });
    const count = await h.jobs.countSubmissions({
      classId: "c1",
      lessonId: "l10",
      email: "teacher@x.com",
      authKind: "google",
    });
    assert.deepEqual(count, { total: 2, pending: 1, alreadyGraded: 1 });
    assert.equal(h.counters.images.length, 0);
  });

  it("refuses to start when no IELTS model is configured", async () => {
    const h = ielts(
      { docA: makeIeltsTab({ tables: [{ essay: ESSAY }] }) },
      { ieltsEnabled: false },
    );
    await assert.rejects(h.start(), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, "ielts_not_configured");
      return true;
    });
  });
});

describe("Basic jobs are untouched by IELTS", () => {
  it("a Basic class never reaches the IELTS grader, even with IELTS tables", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({ answers: ["I done it"] }),
        docB: makeIeltsTab({ tables: [{ essay: ESSAY }] }),
      },
      points: 10,
    });
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).gradingProfile, "basic");
    assert.equal(h.counters.ielts, 0);
    assert.equal(h.counters.images.length, 0);
    assert.equal(h.counters.grade, 1);
    assert.equal(h.docsApi.ieltsFeedbackOf("docB"), "");
  });
});
