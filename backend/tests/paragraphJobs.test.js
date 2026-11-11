/**
 * Grading jobs over a lesson that holds a "Bài tập viết đoạn văn" table next
 * to the sentence exercises. The paragraph is judged by ITS OWN cell, while the
 * sentences keep the doc-level "already graded" rule.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  PARAGRAPH_FEEDBACK,
  createHarness,
  makeTab,
} = require("./helpers/gradingHarness.js");

const STUDENT = "My name are Tom.\nI play usually it every weekend.";
/** PARAGRAPH_FEEDBACK as the doc shows it: "**" became styling. */
const WRITTEN = PARAGRAPH_FEEDBACK.replaceAll("**", "");

async function runJob(h) {
  const { jobId } = await h.start();
  await h.drain();
  return jobId;
}

const gradedTypes = (h) => h.counters.gradedItems.map((it) => it.taskType);

describe("grading job: paragraph writing", () => {
  it("writes sentences and the paragraph, newlines and blank line intact", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it", "ok answer"],
          paragraph: { student: STUDENT },
        }),
      },
      points: 10,
    });
    const jobId = await runJob(h);

    assert.equal(h.job(jobId).written, 1);
    assert.deepEqual(gradedTypes(h), ["vi_en", "vi_en", "paragraph"]);
    // Went around formatFeedbackForDoc, which would have flattened it.
    assert.equal(h.docsApi.paragraphFeedbackOf("docA"), WRITTEN);
    assert.match(WRITTEN, /Tom\.\n\(S “My name”/);
    assert.match(WRITTEN, /nhé\.\)\n\nI usually/);
    // Sentence feedback still goes through formatFeedbackForDoc as before.
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [
      "She has done it.\n(Sai thì.)",
      "✅ Đúng",
    ]);
    assert.match(h.docsApi.overallOf("docA"), /rút kinh nghiệm/);
    assert.equal(h.points(), 9);
  });

  it("grades ONLY the paragraph of a doc whose sentences were graded before", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it", "ok answer"],
          feedback: ["Cô đã chữa", "✅ Đúng"],
          paragraph: { student: STUDENT },
          overall: " Hãy rút kinh nghiệm và cố gắng hơn nữa nhé!🔥🔥",
        }),
      },
      points: 10,
    });
    const jobId = await runJob(h);
    const record = h.docRecords(jobId).docA;

    assert.equal(record.status, "written");
    assert.deepEqual(gradedTypes(h), ["paragraph"]);
    assert.equal(h.docsApi.paragraphFeedbackOf("docA"), WRITTEN);
    // Old sentence feedback untouched, overall comment not doubled.
    assert.deepEqual(h.docsApi.feedbackOf("docA"), ["Cô đã chữa", "✅ Đúng"]);
    assert.equal(
      h.docsApi.overallOf("docA"),
      "Nhận xét chung của Giáo viên: Hãy rút kinh nghiệm và cố gắng hơn nữa nhé!🔥🔥",
    );
    assert.equal(h.points(), 9);
  });

  it("never overwrites a paragraph the teacher already corrected", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it"],
          paragraph: { student: STUDENT, feedback: "Cô sửa tay." },
        }),
      },
      points: 10,
    });
    const jobId = await runJob(h);

    assert.equal(h.docRecords(jobId).docA.status, "written");
    assert.deepEqual(gradedTypes(h), ["vi_en"]);
    assert.equal(h.docsApi.paragraphFeedbackOf("docA"), "Cô sửa tay.");
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [
      "She has done it.\n(Sai thì.)",
    ]);
  });

  it("skips a doc where every cell already has feedback, unbilled", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it"],
          feedback: ["Cô đã chữa"],
          paragraph: { student: STUDENT, feedback: "Cô sửa tay." },
        }),
      },
      points: 10,
    });
    const jobId = await runJob(h);

    const record = h.docRecords(jobId).docA;
    assert.equal(record.status, "skipped");
    assert.equal(record.reason, "alreadyGraded");
    assert.equal(h.counters.grade, 0);
    assert.equal(h.points(), 10);
  });

  it("leaves the paragraph cell empty when the AI returned nothing for it", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it"],
          paragraph: { student: STUDENT },
        }),
      },
      points: 10,
    });
    h.hooks.paragraphFeedback = null;
    const jobId = await runJob(h);

    assert.equal(h.docsApi.paragraphFeedbackOf("docA"), "");
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [
      "She has done it.\n(Sai thì.)",
    ]);
    // …and says so: the doc is written, but not passed off as complete.
    const record = h.docRecords(jobId).docA;
    assert.equal(record.status, "written");
    assert.equal(record.aiSkipped, 1);
    assert.deepEqual(
      record.warnings.filter((w) => w.code === "aiSkippedItems"),
      [{ code: "aiSkippedItems", params: { docId: "docA", count: 1 } }],
    );
    assert.equal(h.job(jobId).incompleteDocs, 1);
    const described = await h.jobs.getJob(jobId, { email: "teacher@x.com" });
    assert.equal(described.incompleteDocs, 1);
  });

  it("counts no incomplete doc when the AI answered everything", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it"],
          paragraph: { student: STUDENT },
        }),
      },
      points: 10,
    });
    const jobId = await runJob(h);

    assert.equal(h.job(jobId).incompleteDocs, 0);
    assert.equal(h.docRecords(jobId).docA.aiSkipped, undefined);
    assert.deepEqual(h.docRecords(jobId).docA.warnings, []);
  });

  it("asks the grader to throw on a passing failure, not to drop items", async () => {
    const h = createHarness({
      tabs: { docA: makeTab({ answers: ["I done it"] }) },
      points: 10,
    });
    await runJob(h);
    assert.equal(h.counters.gradeOptions[0].strict, true);
  });

  it("retries prepare when the AI fails in passing, then writes and charges once", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it", "ok answer"],
          paragraph: { student: STUDENT },
        }),
        docB: makeTab({
          answers: ["ok answer"],
          paragraph: { student: `${STUDENT} More.` },
        }),
      },
      points: 10,
    });
    // What server.js's strict gradeItemsCached throws for a 429 that outlived
    // its retries. Twice, then the provider is back.
    h.hooks.gradeFail = (call) =>
      call <= 2
        ? Object.assign(new Error("AI grading incomplete: 429"), {
            status: 429,
          })
        : null;
    const jobId = await runJob(h);

    const job = h.job(jobId);
    assert.equal(job.status, "done");
    assert.equal(job.error ?? null, null);
    assert.equal(h.counters.grade, 3);
    assert.equal(job.prepareEpoch, 3);
    // Nothing was written by the failed attempts; everything by the third.
    assert.equal(job.written, 2);
    assert.equal(job.incompleteDocs, 0);
    assert.equal(h.docsApi.paragraphFeedbackOf("docA"), WRITTEN);
    assert.equal(h.docsApi.paragraphFeedbackOf("docB"), WRITTEN);
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [
      "She has done it.\n(Sai thì.)",
      "✅ Đúng",
    ]);
    assert.equal(h.points(), 8);
    assert.equal(h.ledger().length, 2);
  });

  it("fails the job, unwritten and unbilled, when the AI never comes back", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it"],
          paragraph: { student: STUDENT },
        }),
      },
      points: 10,
    });
    h.hooks.gradeFail = () =>
      Object.assign(new Error("AI grading incomplete: 429"), { status: 429 });
    const jobId = await runJob(h);

    const job = h.job(jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "prepare_failed");
    assert.match(job.errorParams.msg, /429/);
    assert.equal(job.written, 0);
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [""]);
    assert.equal(h.docsApi.paragraphFeedbackOf("docA"), "");
    assert.equal(h.points(), 10);
    assert.equal(h.ledger().length, 0);
  });

  it("re-running after the paragraph was written grades nothing", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["I done it"],
          paragraph: { student: STUDENT },
        }),
      },
      points: 10,
    });
    await runJob(h);
    const before = h.counters.grade;
    const second = await runJob(h);

    assert.equal(h.counters.grade, before);
    assert.equal(h.docRecords(second).docA.reason, "alreadyGraded");
    assert.equal(h.points(), 9);
  });

  it("writes the teachers' sentence for a paragraph with no mistake, even from an old cached ✅ Đúng", async () => {
    const h = createHarness({
      tabs: {
        docA: makeTab({
          answers: ["ok answer"],
          paragraph: { student: "My name is Tom." },
        }),
      },
      points: 10,
    });
    h.hooks.paragraphFeedback = "✅ Đúng";
    await runJob(h);

    assert.equal(
      h.docsApi.paragraphFeedbackOf("docA"),
      "Các câu đúng hết rồi nha! ^^",
    );
    // Everything right — the paragraph counts as right in the overall comment.
    assert.match(h.docsApi.overallOf("docA"), /Làm tốt lắm/);
  });
});
