/**
 * Grading jobs on IELTS lessons in an older layout: prepare first brings the
 * lesson to the current template (lib/doc/ieltsDoc.js planIeltsTemplateUpdate
 * — the pair table + "NHẬN XÉT" below the writing, a "GV chữa/nhận xét"
 * column on short-sentence tables), then reads and grades it. What the update
 * does to a doc is tested in the website's tests/ieltsTemplate.test.js; this
 * is the job around it.
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
function lessonDoc(spec, converted) {
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

describe("IELTS grading job: the template update in prepare", () => {
  it("updates the lesson in one guarded batch, then grades the writing and the sentences", async () => {
    const lib = await loadLib();
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    h.hooks.ieltsParts = PARTS;
    const plan = lib.planIeltsTemplateUpdate(renderTab(oldSpec()));
    const jobId = await runJob(h);

    // 1st batch: the update, exactly as planned; 2nd: the feedback.
    assert.equal(doc.batches.length, 2);
    assert.deepEqual(doc.batches[0], plan.requests);
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

  it("a lesson already on the template is not touched before grading", async () => {
    const doc = lessonDoc(newSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    await runJob(h);
    assert.equal(doc.batches.length, 1); // the feedback only
    assert.ok(
      !doc.batches[0].some((r) => r.insertTable || r.insertTableColumn),
    );
  });

  it("an update Docs refuses is reported; the lesson is graded as it stands", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    h.docsApi.failNext(
      "batchUpdate",
      new DocsApiError(400, "Invalid requests"),
      { docId: "docA" },
    );
    const jobId = await runJob(h);
    const record = h.docRecords(jobId).docA;
    assert.deepEqual(
      record.warnings.map((w) => w.code),
      ["ieltsTemplateUpdateFailed", "noTable"],
    );
    assert.equal(record.reason, "noTable");
    assert.equal(h.points(), 10);
  });

  it("the doc moved meanwhile: read again, planned again, updated", async () => {
    const doc = lessonDoc(oldSpec(), newSpec());
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    // A student types right before the update lands: the revision moves.
    h.docsApi.failNext("batchUpdate", () => h.docsApi.edit("docA", () => {}), {
      docId: "docA",
    });
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).written, 1);
    assert.ok(doc.batches[0].some((r) => r.insertTable));
  });

  it("rows the AI finds unwritten get nothing; nothing written at all is not charged", async () => {
    const doc = lessonDoc(
      oldSpec({ essay: [["Intro:"], ["Overview:"]] }),
      newSpec({ essay: [["Intro:"], ["Overview:"]] }),
    );
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
    assert.equal(doc.batches.length, 1); // the update only
  });

  it("counting submissions writes nothing, and counts a lesson the update would make gradable", async () => {
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
    assert.deepEqual(count, { total: 1, pending: 1, alreadyGraded: 0 });
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
