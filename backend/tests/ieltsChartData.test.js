/**
 * IELTS Task 1 chart reader (lib/ieltsChartData.js): a chart is read into text
 * once, cached by its images' hashes, and the grader then grades from that
 * text instead of the image.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  CHART_COLLECTION,
  chartKey,
  createChartReader,
  parseChartResponse,
} = require("../lib/ieltsChartData.js");
const {
  CACHE_COLLECTION,
  IeltsError,
  createIeltsGrader,
  ieltsCacheKey,
  validateRequest,
} = require("../lib/ieltsWriting.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");

const png = (text) =>
  `data:image/png;base64,${Buffer.from(text).toString("base64")}`;
const TABLE =
  "Line graph, million tonnes\n| Country | 1970 | 2010 |\n| Spain | 5.6 | 5.1 |";

const task1 = (overrides = {}) =>
  validateRequest({
    task: "task1",
    prompt: "The graph shows fruit production.",
    essay: "Spain produced 5.6 million tonnes.",
    images: [png("chart A")],
    ...overrides,
  });

function task1Json() {
  return JSON.stringify({
    task: "task1",
    corrected: "Spain produced 5.6 million tonnes.",
    improved: "Spain produced 5.6 million tonnes of fruit.",
    criteria: ["TA", "CC", "LR", "GRA"].map((key) => ({
      key,
      band: 6,
      comment: "Ổn nha.",
    })),
    general: "Bài ổn.",
    advice: "Em thêm số liệu nha.",
  });
}

/** A chart reader over a fake db; `answers` are the vision model's replies. */
function setupReader(answers, db = new FakeFirestore()) {
  const calls = [];
  const reader = createChartReader({
    db,
    readPrompt: () => "CHART PROMPT",
    model: "vision-1",
    version: "v1",
    now: () => 1,
    log: () => {},
    callModel: async (instruction, content, model) => {
      calls.push({ instruction, content, model });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { db, reader, calls };
}

describe("chartKey", () => {
  const images = (...names) => task1({ images: names.map(png) }).images;
  const key = (overrides = {}) =>
    chartKey({ version: "v1", model: "m", images: images("A"), ...overrides });

  it("is the same for the same chart, model and version", () => {
    assert.equal(key(), key());
  });

  it("changes with the image, the model and the version", () => {
    const base = key();
    assert.notEqual(key({ images: images("B") }), base);
    assert.notEqual(key({ model: "m2" }), base);
    assert.notEqual(key({ version: "v2" }), base);
  });

  it("depends on the order of several charts", () => {
    assert.notEqual(
      key({ images: images("A", "B") }),
      key({ images: images("B", "A") }),
    );
  });
});

describe("parseChartResponse", () => {
  it("keeps real text and strips a code fence", () => {
    assert.equal(parseChartResponse(`  ${TABLE}  `), TABLE);
    assert.equal(parseChartResponse("```markdown\n" + TABLE + "\n```"), TABLE);
  });

  it("rejects an empty or too short answer", () => {
    assert.equal(parseChartResponse(""), null);
    assert.equal(parseChartResponse(null), null);
    assert.equal(parseChartResponse("không rõ"), null);
  });
});

describe("chart reader", () => {
  it("reads a chart once, then serves it from ieltsChartData", async () => {
    const { db, reader, calls } = setupReader([TABLE]);
    const { images } = task1();
    const first = await reader.read(images);
    const second = await reader.read(images);
    assert.deepEqual(first, { data: TABLE, cached: false });
    assert.deepEqual(second, { data: TABLE, cached: true });
    assert.equal(calls.length, 1);
    const stored = Object.values(db.dump(CHART_COLLECTION));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].data, TABLE);
    assert.equal(stored[0].model, "vision-1");
    assert.deepEqual(stored[0].imageHashes, [images[0].hash]);
  });

  it("sends the prompt as the system message and every image in order", async () => {
    const { reader, calls } = setupReader([TABLE]);
    await reader.read(task1({ images: [png("A"), png("B")] }).images);
    const { instruction, content, model } = calls[0];
    assert.equal(instruction, "CHART PROMPT");
    assert.equal(model, "vision-1");
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /Ảnh 1, Ảnh 2/);
    assert.deepEqual(
      content.slice(1).map((part) => part.image_url.url),
      [png("A"), png("B")],
    );
  });

  it("essays about the same chart graded at once share one read", async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const db = new FakeFirestore();
    let calls = 0;
    const reader = createChartReader({
      db,
      readPrompt: () => "P",
      model: "vision-1",
      version: "v1",
      log: () => {},
      callModel: async () => {
        calls++;
        await gate;
        return TABLE;
      },
    });
    const { images } = task1();
    const pending = [
      reader.read(images),
      reader.read(images),
      reader.read(images),
    ];
    release();
    const results = await Promise.all(pending);
    assert.equal(calls, 1);
    assert.ok(results.every((r) => r.data === TABLE));
  });

  it("retries once, and caches nothing when both answers are unusable", async () => {
    const retried = setupReader([new Error("timeout"), TABLE]);
    assert.equal((await retried.reader.read(task1().images)).data, TABLE);
    assert.equal(retried.calls.length, 2);

    const failed = setupReader(["", "??", "never asked"]);
    await assert.rejects(failed.reader.read(task1().images), (err) => {
      assert.ok(err instanceof IeltsError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "ielts_chart_unreadable");
      return true;
    });
    assert.equal(failed.calls.length, 2);
    assert.equal(Object.keys(failed.db.dump(CHART_COLLECTION)).length, 0);
  });

  it("reads a new chart again; a deleted entry is read again", async () => {
    const { db, reader, calls } = setupReader([TABLE, TABLE, TABLE]);
    await reader.read(task1().images);
    await reader.read(task1({ images: [png("another chart")] }).images);
    assert.equal(calls.length, 2);

    const [id] = Object.keys(db.dump(CHART_COLLECTION));
    await db.collection(CHART_COLLECTION).doc(id).delete();
    await reader.read(task1().images);
    await reader.read(task1({ images: [png("another chart")] }).images);
    assert.equal(calls.length, 3);
  });

  it("re-reads when the cache is skipped", async () => {
    const { reader, calls } = setupReader([TABLE, TABLE]);
    await reader.read(task1().images);
    await reader.read(task1().images, { useCache: false });
    assert.equal(calls.length, 2);
  });
});

describe("grader with a chart reader", () => {
  function setup({
    chartAnswers = [TABLE],
    gradeAnswers = [task1Json()],
  } = {}) {
    const db = new FakeFirestore();
    const chart = setupReader(chartAnswers, db);
    const gradeCalls = [];
    const grader = createIeltsGrader({
      db,
      readPrompt: () => "PROMPT",
      model: "text-1",
      promptVersion: "v1",
      now: () => 1,
      log: () => {},
      readChart: chart.reader.read,
      callModel: async (instruction, content) => {
        gradeCalls.push(content);
        return gradeAnswers.shift();
      },
    });
    return { db, grader, chartCalls: chart.calls, gradeCalls };
  }

  it("grades Task 1 from the chart text and never sends the image", async () => {
    const { grader, gradeCalls } = setup();
    const graded = await grader.grade(task1());
    assert.equal(graded.chartData, TABLE);
    assert.equal(gradeCalls.length, 1);
    const content = gradeCalls[0];
    assert.equal(content.length, 1, "text only");
    assert.equal(content[0].type, "text");
    assert.ok(
      content[0].text.includes(`(đã trích từ ảnh đề bài):\n${TABLE}\n`),
    );
    // The data sits between the prompt and the essay.
    const text = content[0].text;
    assert.ok(text.indexOf("[ĐỀ BÀI]") < text.indexOf("[DỮ LIỆU BIỂU ĐỒ]"));
    assert.ok(text.indexOf("[DỮ LIỆU BIỂU ĐỒ]") < text.indexOf("[BÀI LÀM"));
  });

  it("the class's second essay about the chart pays no second read", async () => {
    const { grader, chartCalls, gradeCalls } = setup({
      gradeAnswers: [task1Json(), task1Json()],
    });
    await grader.grade(task1());
    await grader.grade(task1({ essay: "Spain produced 5.6 tonnes." }));
    assert.equal(chartCalls.length, 1);
    assert.equal(gradeCalls.length, 2);
  });

  it("an identical resubmission is served from the grading cache", async () => {
    const { grader, chartCalls, gradeCalls } = setup();
    await grader.grade(task1());
    const again = await grader.grade(task1());
    assert.equal(again.cached, true);
    assert.equal(again.chartData, TABLE);
    assert.equal(chartCalls.length, 1);
    assert.equal(gradeCalls.length, 1);
  });

  it("the grading cache key follows the chart text", () => {
    const input = task1();
    const key = (chartData) =>
      ieltsCacheKey({ promptVersion: "v1", model: "m", chartData, ...input });
    assert.notEqual(key(TABLE), key(`${TABLE}\n| Turkey | 1.5 | 3.5 |`));
    assert.notEqual(key(TABLE), key(null));
    // Whitespace alone does not change it.
    assert.equal(key(TABLE), key(`${TABLE.replaceAll("\n", "\r\n")}  \n`));
    // Without chart text the key is the one used before the chart reader.
    assert.equal(
      key(null),
      ieltsCacheKey({ promptVersion: "v1", model: "m", ...input }),
    );
  });

  it("a chart the reader cannot read fails the grading, caching nothing", async () => {
    const { db, grader, gradeCalls } = setup({ chartAnswers: ["", ""] });
    await assert.rejects(grader.grade(task1()), (err) => {
      assert.equal(err.code, "ielts_chart_unreadable");
      return true;
    });
    assert.equal(gradeCalls.length, 0);
    assert.equal(Object.keys(db.dump(CACHE_COLLECTION)).length, 0);
  });

  it("a paragraph about a chart is graded from the chart text too", async () => {
    const paragraph = JSON.stringify({
      ...JSON.parse(task1Json()),
      task: "paragraph",
      criteria: [],
    });
    const { grader, chartCalls, gradeCalls } = setup({
      gradeAnswers: [paragraph],
    });
    const graded = await grader.grade(
      task1({ task: "paragraph", essay: "Spain produced 5.6 million tonnes." }),
    );
    assert.equal(chartCalls.length, 1);
    assert.equal(graded.chartData, TABLE);
    const content = gradeCalls[0];
    assert.equal(content.length, 1, "text only, no image");
    assert.match(content[0].text, /[DỮ LIỆU BIỂU ĐỒ]/);
  });

  it("a paragraph without images never asks the chart reader", async () => {
    const paragraph = JSON.stringify({
      ...JSON.parse(task1Json()),
      task: "paragraph",
      criteria: [],
    });
    const { grader, chartCalls } = setup({ gradeAnswers: [paragraph] });
    const graded = await grader.grade(task1({ task: "paragraph", images: [] }));
    assert.equal(chartCalls.length, 0);
    assert.equal(graded.chartData, null);
  });

  it("Task 2 never asks the chart reader", async () => {
    const task2 = JSON.stringify({
      ...JSON.parse(task1Json()),
      task: "task2",
      criteria: ["TR", "CC", "LR", "GRA"].map((key) => ({
        key,
        band: 6,
        comment: "x",
      })),
    });
    const { grader, chartCalls } = setup({ gradeAnswers: [task2] });
    const graded = await grader.grade(
      validateRequest({ task: "task2", prompt: "Đề", essay: "Essay." }),
    );
    assert.equal(chartCalls.length, 0);
    assert.equal(graded.chartData, null);
  });
});
