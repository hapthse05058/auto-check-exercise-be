/**
 * IELTS lessons in an older layout. The teacher's "update template" button
 * (updateTemplates) brings them to the current template (lib/doc/ieltsDoc.js
 * planIeltsTemplateUpdate — the pair table + "NHẬN XÉT" below the writing,
 * a "GV chữa/nhận xét" column on short-sentence tables); grading reads a
 * lesson as it stands and never changes its template. What the update does
 * to a doc is tested in the website's tests/ieltsTemplate.test.js.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DocsApiError } = require("../lib/googleDocsApi.js");
const {
  IELTS_FEEDBACK,
  createHarness,
} = require("./helpers/gradingHarness.js");

const loadLib = () => import("../lib/doc/ieltsDoc.js");

/**
 * A tab from blocks — "text" (a paragraph), {image}, {table: [[cell]]} —
 * indexed like the Docs API: a table takes 1, each row 1, each cell 1 + its
 * text, and 1 for its end.
 */
function renderTab(spec) {
  let at = 1;
  const para = (text) => {
    const start = at;
    at += text.length;
    return {
      startIndex: start,
      endIndex: at,
      paragraph: {
        elements: [
          { startIndex: start, endIndex: at, textRun: { content: text } },
        ],
      },
    };
  };
  const content = spec.map((block) => {
    if (typeof block === "string") return para(`${block}\n`);
    if (block.image) {
      const start = at;
      at += 2;
      return {
        startIndex: start,
        endIndex: at,
        paragraph: {
          elements: [
            {
              startIndex: start,
              endIndex: start + 1,
              inlineObjectElement: { inlineObjectId: block.image },
            },
            { startIndex: start + 1, endIndex: at, textRun: { content: "\n" } },
          ],
        },
      };
    }
    const start = at;
    at += 1;
    const tableRows = block.table.map((row) => {
      const rowStart = at;
      at += 1;
      const tableCells = row.map((text) => {
        const cellStart = at;
        at += 1;
        const paras = `${text}\n`.split(/(?<=\n)/).map(para);
        return { startIndex: cellStart, endIndex: at, content: paras };
      });
      return { startIndex: rowStart, endIndex: at, tableCells };
    });
    at += 1;
    return {
      startIndex: start,
      endIndex: at,
      table: {
        rows: block.table.length,
        columns: block.table[0].length,
        tableRows,
      },
    };
  });
  return {
    tabProperties: { title: "Writing buổi 10", tabId: "t.w" },
    documentTab: {
      body: { content },
      namedRanges: {},
      inlineObjects: {
        chart1: {
          inlineObjectProperties: {
            embeddedObject: {
              imageProperties: { contentUri: "https://img/1" },
            },
          },
        },
      },
    },
  };
}

const EXERCISE_2 = "Exercise 2: Viết Intro và Overview cho đề sau đây";
const EXERCISE_3 = "Exercise 3: Viết câu mô tả số liệu của các đối tượng";
const ESSAY = [["Intro: The graph show fish."], ["Overview: Fish rose."]];
const SENTENCES = [
  ["Sđơn vị… + V + adv: It wrong."],
  ["Sgiả (There) …: There was a rise."],
  ["S thay đổi + was seen in…:"],
];

/** The lesson in the course's own doc (`essay` null: nothing written). */
const oldSpec = ({ essay = ESSAY, sentences = SENTENCES } = {}) => [
  EXERCISE_2,
  "The graph below shows fish.",
  { image: "chart1" },
  { table: essay },
  "",
  EXERCISE_3,
  { table: sentences },
  "Sau khi viết xong, hãy tích vào các ô sau đây",
];

/** The same lesson as Docs leaves it after the update. */
const newSpec = ({ essay = ESSAY, sentences = SENTENCES } = {}) => [
  EXERCISE_2,
  "The graph below shows fish.",
  { image: "chart1" },
  { table: essay },
  "",
  { table: [["GV chữa/nhận xét", "BẢN CẢI THIỆN"]] },
  "NHẬN XÉT",
  "",
  EXERCISE_3,
  {
    table: [
      ["Câu của học viên", "GV chữa/nhận xét"],
      ...sentences.map((row) => [...row, ""]),
    ],
  },
  "Sau khi viết xong, hãy tích vào các ô sau đây",
];

/** A doc whose template-update batch turns it into `converted`. */
function lessonDoc(spec, converted = spec) {
  const batches = [];
  const tab = renderTab(spec);
  const apply = (target, requests) => {
    batches.push(requests);
    if (requests.some((r) => r.insertTable || r.insertTableColumn)) {
      target.documentTab = renderTab(converted).documentTab;
    }
  };
  return { value: { tab, apply }, batches };
}

const PARTS = {
  corrected: "Intro: The graph **show** → shows (S-V) fish.",
  improved: "The graph shows fish.",
  review: "**Nhận xét chung:** Ổn nha.",
};

async function runJob(h) {
  const { jobId } = await h.start();
  await h.drain();
  return jobId;
}

const updateTemplates = (h, overrides = {}) =>
  h.jobs.updateTemplates({
    email: "teacher@x.com",
    authKind: "google",
    classId: "c1",
    lessonId: "l10",
    ...overrides,
  });

const SUMMARY = {
  total: 1,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  tables: 0,
  noTable: 0,
};

describe("IELTS template update (its own button)", () => {
  it("updates the lesson in one guarded batch; grading then fills the writing and the sentences", async () => {
    const lib = await loadLib();
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    h.hooks.ieltsParts = PARTS;
    const plan = lib.planIeltsTemplateUpdate(renderTab(oldSpec()));

    const summary = await updateTemplates(h);
    assert.deepEqual(summary, { ...SUMMARY, updated: 1, tables: 2 });
    assert.equal(doc.batches.length, 1);
    assert.deepEqual(doc.batches[0], plan.requests);
    assert.equal(h.points(), 10); // the update is free

    const jobId = await runJob(h);
    assert.equal(doc.batches.length, 2); // + the feedback
    assert.equal(h.job(jobId).written, 1);
    assert.equal(h.points(), 9);

    const [essay] = h.counters.ieltsInputs;
    assert.equal(essay.task, "paragraph");
    assert.equal(
      essay.essay,
      "Intro: The graph show fish.\nOverview: Fish rose.",
    );
    assert.equal(essay.prompt, `${EXERCISE_2}\nThe graph below shows fish.`);
    assert.equal(essay.images.length, 1);

    const [table] = h.counters.sentenceInputs;
    assert.deepEqual(table.columns, ["Câu của học viên"]);
    assert.deepEqual(
      table.rows.map((r) => r.cells[0]),
      ["Sđơn vị… + V + adv: It wrong.", "Sgiả (There) …: There was a rise."],
    );
    assert.match(table.prompt, /^Exercise 3: /);

    // The feedback: three pieces for the pair, one per written sentence.
    const inserts = doc.batches[1]
      .filter((r) => r.insertText)
      .map((r) => r.insertText.text);
    assert.deepEqual(inserts.sort(), [
      "\nIntro: The graph show → shows (S-V) fish.",
      "\nNhận xét chung: Ổn nha.",
      "\nThe graph shows fish.",
      "It wrong → right (thì).",
      "✅",
    ]);
  });

  it("a lesson already on the template is left alone", async () => {
    const doc = lessonDoc(newSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      gradingProfile: "ielts",
    });
    assert.deepEqual(await updateTemplates(h), { ...SUMMARY, unchanged: 1 });
    assert.equal(doc.batches.length, 0);
  });

  it("an update Docs refuses is counted as failed", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      gradingProfile: "ielts",
    });
    h.docsApi.failNext(
      "batchUpdate",
      new DocsApiError(400, "Invalid requests"),
      { docId: "docA" },
    );
    assert.deepEqual(await updateTemplates(h), { ...SUMMARY, failed: 1 });
  });

  it("the doc moved meanwhile: read again, planned again, updated", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      gradingProfile: "ielts",
    });
    // A student types right before the update lands: the revision moves.
    h.docsApi.failNext("batchUpdate", () => h.docsApi.edit("docA", () => {}), {
      docId: "docA",
    });
    const summary = await updateTemplates(h);
    assert.equal(summary.updated, 1);
    assert.ok(doc.batches[0].some((r) => r.insertTable));
  });

  it("is refused while the lesson is being graded, and for a non-IELTS class", async () => {
    const doc = lessonDoc(newSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      gradingProfile: "ielts",
    });
    const { jobId } = await h.start();
    await assert.rejects(updateTemplates(h), {
      code: "job_in_progress",
      status: 409,
      params: { jobId },
    });

    const basic = createHarness({
      tabs: { docA: lessonDoc(oldSpec()).value },
    });
    await assert.rejects(updateTemplates(basic), {
      code: "not_ielts_class",
      status: 400,
    });
  });

  it("only the class's teacher (or an admin) may run it", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      gradingProfile: "ielts",
    });
    await assert.rejects(updateTemplates(h, { email: "other@x.com" }), {
      code: "payer_not_found",
      status: 403,
    });
    assert.equal(doc.batches.length, 0);
  });
});

describe("IELTS grading job on an older template", () => {
  it("grading does not change the template: the lesson is skipped and the teacher told to update", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    const jobId = await runJob(h);
    assert.equal(doc.batches.length, 0);
    const record = h.docRecords(jobId).docA;
    assert.equal(record.reason, "ieltsTemplateOutdated");
    assert.deepEqual(
      record.warnings.map((w) => w.code),
      ["ieltsTemplateOutdated"],
    );
    assert.equal(h.job(jobId).notice, "allIeltsTemplateOutdated");
    assert.deepEqual(h.job(jobId).noticeParams, { count: 1 });
    assert.equal(h.points(), 10);
  });

  it("counting submissions writes nothing and does not count an outdated lesson", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    const count = await h.jobs.countSubmissions({
      classId: "c1",
      lessonId: "l10",
      email: "teacher@x.com",
      authKind: "google",
    });
    assert.deepEqual(count, { total: 1, pending: 0, alreadyGraded: 0 });
    assert.equal(doc.batches.length, 0);
  });

  it("rows the AI finds unwritten get nothing; nothing written at all is not charged", async () => {
    const doc = lessonDoc(newSpec({ essay: [["Intro:"], ["Overview:"]] }));
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    h.hooks.sentenceVerdicts = (input) =>
      new Map(
        input.rows.map((r) => [r.row, { verdict: "blank", feedback: "" }]),
      );
    const jobId = await runJob(h);
    assert.equal(h.counters.ielts, 0); // labels only: not written
    assert.equal(h.counters.sentenceInputs.length, 1);
    assert.equal(h.docRecords(jobId).docA.reason, "noMatch");
    assert.equal(h.points(), 10);
    assert.equal(doc.batches.length, 0);
  });

  it("an IELTS feedback without parts still lands whole in the left cell", async () => {
    const doc = lessonDoc(newSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    await runJob(h);
    const inserts = doc.batches[0]
      .filter((r) => r.insertText)
      .map((r) => r.insertText.text);
    assert.ok(inserts.includes(`\n${IELTS_FEEDBACK.replaceAll("**", "")}`));
  });
});
