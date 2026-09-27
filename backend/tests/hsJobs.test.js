/**
 * Grading jobs for an HS class (course gradingProfile "hs"): the lesson's
 * items are read against the blank form (lib/doc/hsDoc.js), graded by the HS
 * grader and written right after each answer — sharing the job's leases,
 * write-once rule and per-doc receipts with Basic and IELTS. Also: the
 * profile routing is fail-closed, and Basic/IELTS never reach the HS grader.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DocsApiError } = require("../lib/googleDocsApi.js");
const { JobError } = require("../lib/gradingJobs.js");
const {
  createHarness,
  makeIeltsTab,
  makeTab,
} = require("./helpers/gradingHarness.js");
const {
  B19_ITEMS,
  RED,
  b19Doc,
  blankHsDoc,
  findParagraph,
  paraText,
  tabByTitle,
  typeInto,
} = require("./helpers/hsDocs.js");

const B19 = { id: "hsLesson19", name: "Buổi 19" };

const hs = (docs, options = {}) =>
  createHarness({
    tabs: docs,
    points: 10,
    gradingProfile: "hs",
    lesson: B19,
    ...options,
  });

async function runJob(h) {
  const { jobId } = await h.start();
  await h.drain();
  return jobId;
}

/** Text of item `i` (0-based) of Buổi 19 Ex2 in a stored doc. */
const b19Line = (h, docId, i) =>
  paraText(
    findParagraph(
      tabByTitle(h.docsApi.docs.get(docId).doc, "Buổi 19"),
      B19_ITEMS[i][0],
    ),
  );

const warningCodes = (h, jobId) =>
  Object.values(h.docRecords(jobId)).flatMap((d) =>
    (d.warnings || []).map((w) => w.code),
  );

describe("HS grading job", () => {
  it("grades the written items, writes after each answer, 1 point per doc", async () => {
    const h = hs({ docA: b19Doc(4), docB: b19Doc(2) });
    const jobId = await runJob(h);

    const job = h.job(jobId);
    assert.equal(job.gradingProfile, "hs");
    assert.equal(job.written, 2);
    assert.equal(h.points(), 8);
    // Only the HS grader was asked — once for the whole class.
    assert.equal(h.counters.hs, 1);
    assert.equal(h.counters.grade, 0);
    assert.equal(h.counters.ielts, 0);
    assert.equal(h.counters.hsItems.length, 6);
    assert.deepEqual(
      [...new Set(h.counters.hsItems.map((i) => i.lessonId))],
      ["hsLesson19"],
    );
    // One batchUpdate per doc.
    assert.equal(h.docsApi.calls.applied, 2);

    // After the form's leftover "____", like the teachers' own ticks.
    assert.match(b19Line(h, "docA", 0), /on the table\.[_ ]*✅Well-done!\n$/);
    // A wrong one: a soft line break (stays in the list item), then the fix.
    assert.ok(
      b19Line(h, "docA", 2).endsWith(
        "\u000bCâu đúng: Fixed it. (vì vậy nhé)\n",
      ),
    );
    // Untouched items stay untouched.
    assert.doesNotMatch(
      paraText(
        findParagraph(
          tabByTitle(h.docsApi.docs.get("docA").doc, "Buổi 19"),
          "The cat is sleeping",
        ),
      ),
      /Well-done|Câu đúng/,
    );
  });

  it("partial grading: the teacher's ticks are kept, only the rest is graded", async () => {
    const h = hs({ docA: b19Doc(4, { teacherTicks: 2 }) });
    const before = [0, 1].map((i) => b19Line(h, "docA", i));
    await runJob(h);
    assert.deepEqual(
      h.counters.hsItems.map((i) => i.prompt.slice(0, 20)),
      ["The bus stop is unde", "My house is on the l"],
    );
    assert.deepEqual(
      [0, 1].map((i) => b19Line(h, "docA", i)),
      before,
    );
    assert.match(b19Line(h, "docA", 3), /Câu đúng/);
  });

  it("skips a doc with nothing written, and one fully corrected", async () => {
    const h = hs({
      empty: blankHsDoc(),
      done: b19Doc(2, { teacherTicks: 2 }),
      todo: b19Doc(1),
    });
    const jobId = await runJob(h);
    const records = h.docRecords(jobId);
    assert.equal(records.empty.reason, "noAnswers");
    assert.equal(records.done.reason, "alreadyGraded");
    assert.equal(records.todo.status, "written");
    assert.equal(h.points(), 9);
  });

  it("drops items a teacher corrected between grading and writing", async () => {
    const h = hs({ docA: b19Doc(2) });
    const { jobId } = await h.start();
    // prepare only — then the teacher ticks item 1 before the write.
    const prepare = h.queue.pending.shift();
    await h.jobs.handleTask(prepare.payload);
    h.docsApi.edit("docA", (doc) =>
      typeInto(doc, tabByTitle(doc, "Buổi 19"), B19_ITEMS[0][0], " ✅", {
        style: RED,
      }),
    );
    await h.drain();
    assert.equal(h.job(jobId).written, 1);
    assert.match(b19Line(h, "docA", 0), / ✅\n$/); // the teacher's, alone
    assert.match(b19Line(h, "docA", 1), /✅Well-done!/);
  });

  it("skips (no charge) a doc the teacher fully corrected meanwhile", async () => {
    const h = hs({ docA: b19Doc(1) });
    const { jobId } = await h.start();
    await h.jobs.handleTask(h.queue.pending.shift().payload);
    h.docsApi.edit("docA", (doc) =>
      typeInto(doc, tabByTitle(doc, "Buổi 19"), B19_ITEMS[0][0], " ✅", {
        style: RED,
      }),
    );
    await h.drain();
    assert.equal(h.docRecords(jobId).docA.reason, "gradedMeanwhile");
    assert.equal(h.points(), 10);
  });

  it("a write that went through before a crash is billed once, never rewritten", async () => {
    const h = hs({ docA: b19Doc(2) });
    h.docsApi.failNext("batchUpdate", new DocsApiError(0, "reset"), {
      phase: "after",
    });
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).written, 1);
    assert.equal(h.points(), 9);
    assert.equal(h.docsApi.calls.applied, 1);
    // Exactly one correction per item.
    assert.equal(b19Line(h, "docA", 0).split("Well-done").length, 2);
  });

  it("leaves items the grader could not grade unwritten, with a warning", async () => {
    const h = hs({ docA: b19Doc(2) });
    h.hooks.hsVerdict = (item) =>
      item.prompt.startsWith("There is a lamp") ? null : { correct: true };
    const jobId = await runJob(h);
    assert.ok(warningCodes(h, jobId).includes("hsAiInvalid"));
    assert.doesNotMatch(b19Line(h, "docA", 0), /Well-done|Câu đúng/);
    assert.match(b19Line(h, "docA", 1), /✅Well-done!/);
  });

  it("is refused up front when the HS model is not configured", async () => {
    const h = hs({ docA: b19Doc(1) }, { hsEnabled: false });
    await assert.rejects(h.start(), (err) => {
      assert.ok(err instanceof JobError);
      assert.equal(err.code, "hs_not_configured");
      return true;
    });
  });

  it("counts submissions per doc, like Basic", async () => {
    const h = hs({
      a: b19Doc(2),
      b: b19Doc(2, { teacherTicks: 2 }),
      c: blankHsDoc(),
    });
    const count = await h.jobs.countSubmissions({
      classId: "c1",
      lessonId: B19.id,
      email: "teacher@x.com",
      authKind: "google",
    });
    assert.deepEqual(count, { total: 3, pending: 1, alreadyGraded: 1 });
    assert.equal(h.counters.hs, 0); // counting never grades
  });
});

describe("grading profile routing (fail closed)", () => {
  it("basic → Basic grader only; ielts → IELTS only; hs → HS only", async () => {
    const basic = createHarness({ tabs: { d: makeTab({ answers: ["ok"] }) } });
    await runJob(basic);
    assert.deepEqual(
      [basic.counters.grade, basic.counters.ielts, basic.counters.hs],
      [1, 0, 0],
    );

    const ielts = createHarness({
      tabs: { d: makeIeltsTab({ tables: [{ essay: "An essay." }] }) },
      gradingProfile: "ielts",
    });
    await runJob(ielts);
    assert.deepEqual(
      [ielts.counters.grade, ielts.counters.ielts, ielts.counters.hs],
      [0, 1, 0],
    );

    const h = hs({ d: b19Doc(1) });
    await runJob(h);
    assert.deepEqual(
      [h.counters.grade, h.counters.ielts, h.counters.hs],
      [0, 0, 1],
    );
  });

  it("an unknown profile is refused — never graded as Basic", async () => {
    for (const profile of [null, "toeic"]) {
      const h = createHarness({
        tabs: { d: makeTab({ answers: ["ok"] }) },
        gradingProfile: profile,
      });
      await assert.rejects(h.start(), (err) => {
        assert.equal(err.code, "unknown_grading_profile");
        return true;
      });
      assert.equal(h.counters.grade, 0);
    }
  });

  it("a stored job with an unknown profile fails at prepare", async () => {
    const h = createHarness({ tabs: { d: makeTab({ answers: ["ok"] }) } });
    const { jobId } = await h.start();
    await h.db
      .collection("gradingJobs")
      .doc(jobId)
      .update({ gradingProfile: "toeic" });
    await h.drain();
    assert.equal(h.job(jobId).error, "unknown_grading_profile");
    assert.equal(h.counters.grade, 0);
    assert.equal(h.points(), 100);
  });
});
