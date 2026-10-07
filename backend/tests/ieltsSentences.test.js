const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  CACHE_COLLECTION,
  buildSentenceContent,
  createIeltsSentenceGrader,
  parseSentenceResponse,
  sentenceCacheKey,
  sentenceSilentEdits,
  validateSentenceRequest,
} = require("../lib/ieltsSentences.js");
const { IeltsError } = require("../lib/ieltsWriting.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");

const PNG = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

const table = (overrides = {}) => ({
  prompt: "Exercise 3: Viết câu mô tả số liệu\n1, Mô tả Spain - Giảm đều",
  columns: ["Câu của học viên"],
  rows: [
    {
      row: 1,
      cells: ["Sđơn vị… + V + adv: The production in Spain decrease steadily."],
    },
    { row: 2, cells: ["Sgiả (There) …: There was a steady fall."] },
    { row: 3, cells: ["S thay đổi + was seen in…:"] },
  ],
  ...overrides,
});

const answer = (rows) => JSON.stringify({ rows });
const GOOD = answer([
  {
    row: 1,
    verdict: "fix",
    feedback:
      "The production in Spain **decrease** → decreased (thì) steadily.",
  },
  { row: 2, verdict: "correct", feedback: "✅" },
  { row: 3, verdict: "blank", feedback: "" },
]);

describe("validateSentenceRequest", () => {
  it("keeps the table and normalises the charts", () => {
    const input = validateSentenceRequest({ ...table(), images: [PNG] });
    assert.equal(input.rows.length, 3);
    assert.equal(input.images.length, 1);
    assert.match(input.images[0].hash, /^[0-9a-f]{64}$/);
  });

  it("refuses what cannot be graded", () => {
    const code = (body) => {
      try {
        validateSentenceRequest(body);
        return null;
      } catch (err) {
        assert.ok(err instanceof IeltsError);
        return err.code;
      }
    };
    assert.equal(code(table({ prompt: " " })), "prompt_required");
    assert.equal(code(table({ rows: [] })), "essay_required");
    assert.equal(code(table({ columns: [] })), "invalid_columns");
    assert.equal(
      code(table({ rows: [{ row: 1, cells: ["a", "b"] }] })),
      "invalid_rows",
    );
    assert.equal(
      code(
        table({
          rows: [
            { row: 1, cells: ["a"] },
            { row: 1, cells: ["b"] },
          ],
        }),
      ),
      "invalid_rows",
    );
  });
});

describe("parseSentenceResponse", () => {
  it("one verdict per row asked; ✅ for a right sentence, nothing for an empty one", () => {
    const out = parseSentenceResponse(GOOD, [1, 2, 3]);
    assert.deepEqual(
      [...out],
      [
        [
          1,
          {
            verdict: "fix",
            feedback:
              "The production in Spain **decrease** → decreased (thì) steadily.",
          },
        ],
        [2, { verdict: "correct", feedback: "✅" }],
        [3, { verdict: "blank", feedback: "" }],
      ],
    );
  });

  it("refuses a row missing, a row not asked, a fix without text, a bad verdict", () => {
    assert.equal(
      parseSentenceResponse(answer([{ row: 1, verdict: "correct" }]), [1, 2]),
      null,
    );
    assert.equal(
      parseSentenceResponse(answer([{ row: 9, verdict: "correct" }]), [1]),
      null,
    );
    assert.equal(
      parseSentenceResponse(
        answer([{ row: 1, verdict: "fix", feedback: "" }]),
        [1],
      ),
      null,
    );
    assert.equal(
      parseSentenceResponse(answer([{ row: 1, verdict: "ok" }]), [1]),
      null,
    );
    assert.equal(parseSentenceResponse("not json", [1]), null);
  });
});

describe("buildSentenceContent", () => {
  it("labels each row with its columns; the chart as text when it was read", () => {
    const input = validateSentenceRequest({
      ...table({
        columns: ["Loại chủ ngữ", "Câu mô tả"],
        rows: [{ row: 1, cells: ["Chủ ngữ người", "Boys enjoys it."] }],
      }),
      images: [PNG],
    });
    const withImage = buildSentenceContent(input);
    assert.match(withImage[0].text, /\[CÁC CỘT\]: Loại chủ ngữ \| Câu mô tả/);
    assert.match(
      withImage[0].text,
      /Dòng 1: Loại chủ ngữ: Chủ ngữ người \| Câu mô tả: Boys enjoys it\./,
    );
    assert.equal(withImage[1].type, "image_url");
    const withData = buildSentenceContent({
      ...input,
      chartData: "Spain 1980 ~6.0",
    });
    assert.equal(withData.length, 1);
    assert.match(
      withData[0].text,
      /\[DỮ LIỆU BIỂU ĐỒ\][^\n]*\nSpain 1980 ~6\.0/,
    );
  });
});

describe("sentenceSilentEdits", () => {
  const verdict = (feedback) => new Map([[1, { verdict: "fix", feedback }]]);
  it("an unmarked change to the student's words is caught", () => {
    const rows = [
      { row: 1, cells: ["With: There were fluctuations from 1990 to 2010."] },
    ];
    const edits = sentenceSilentEdits(
      rows,
      verdict(
        "There were **fluctuations** → slight fluctuations from 1990 and 2010.",
      ),
    );
    assert.deepEqual(
      edits.map((e) => e.words),
      ["to"],
    );
  });

  it("the teacher's label column and a Vietnamese cell not repeated are not the student's words", () => {
    const rows = [
      {
        row: 1,
        cells: [
          "Chủ ngữ người",
          "Girls in New Zealand enjoys going to the park.",
        ],
      },
    ];
    assert.deepEqual(
      sentenceSilentEdits(
        rows,
        verdict(
          "Girls in New Zealand **enjoys** → enjoyed (thì) going to the park.",
        ),
      ),
      [],
    );
    const bilingual = [
      {
        row: 1,
        cells: [
          "Trẻ em có thể giữ liên lạc với bạn bè.",
          "Children can keep in touch with friends.",
        ],
      },
    ];
    assert.deepEqual(
      sentenceSilentEdits(
        bilingual,
        verdict("Children can keep in touch with **friends** → their friends."),
      ),
      [],
    );
  });
});

describe("grader", () => {
  const make = (answers, { readChart = null } = {}) => {
    const db = new FakeFirestore();
    const calls = [];
    const grader = createIeltsSentenceGrader({
      db,
      callModel: async (instruction, content) => {
        calls.push(content);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
      readPrompt: () => "PROMPT",
      model: "m",
      promptVersion: "v1",
      readChart,
      log: () => {},
    });
    return { db, calls, grader };
  };

  it("grades, caches, and answers a second time from the cache", async () => {
    const { db, calls, grader } = make([GOOD]);
    const input = validateSentenceRequest(table());
    const first = await grader.grade(input);
    assert.equal(first.cached, false);
    assert.equal(first.results.get(2).feedback, "✅");
    const second = await grader.grade(input);
    assert.equal(second.cached, true);
    assert.deepEqual([...second.results], [...first.results]);
    assert.equal(calls.length, 1);
    assert.equal(Object.keys(db.dump(CACHE_COLLECTION)).length, 1);
  });

  it("an unusable answer is asked again once; twice fails with ielts_ai_invalid", async () => {
    const { grader } = make(["nope", GOOD]);
    const { results } = await grader.grade(validateSentenceRequest(table()));
    assert.equal(results.get(1).verdict, "fix");
    const { grader: bad } = make(["nope", new Error("down")]);
    await assert.rejects(bad.grade(validateSentenceRequest(table())), {
      code: "ielts_ai_invalid",
    });
  });

  it("a silent edit is asked again with the words named; the cleaner answer wins", async () => {
    const silent = answer([
      {
        row: 1,
        verdict: "fix",
        feedback: "The output in Spain **decrease** → decreased steadily.",
      },
      { row: 2, verdict: "correct", feedback: "✅" },
      { row: 3, verdict: "blank", feedback: "" },
    ]);
    const { calls, grader } = make([silent, GOOD]);
    const { results } = await grader.grade(validateSentenceRequest(table()));
    assert.equal(calls.length, 2);
    assert.match(
      calls[1].at(-1).text,
      /\[KIỂM TRA LẠI\][\s\S]*Dòng 1: "production"/,
    );
    assert.match(results.get(1).feedback, /The production in Spain/);
  });

  it("a fix that only copies the sentence back is shown as right", async () => {
    const copied = answer([
      {
        row: 1,
        verdict: "fix",
        feedback: "The output in Spain **decrease** → decreased steadily.",
      },
      { row: 2, verdict: "fix", feedback: "There was a steady fall" },
      { row: 3, verdict: "blank", feedback: "" },
    ]);
    // The first answer's silent edit makes it ask again; same answer wins.
    const { grader } = make([copied, copied, copied]);
    const { results } = await grader.grade(validateSentenceRequest(table()));
    assert.deepEqual(results.get(2), { verdict: "correct", feedback: "✅" });
    assert.equal(results.get(1).verdict, "fix");
  });

  it("the chart is read into text first and is part of the cache key", async () => {
    const reads = [];
    const { calls, grader } = make([GOOD], {
      readChart: async (images) => {
        reads.push(images.length);
        return { data: "Spain 1980 ~6.0" };
      },
    });
    await grader.grade(validateSentenceRequest({ ...table(), images: [PNG] }));
    assert.deepEqual(reads, [1]);
    assert.match(calls[0][0].text, /Spain 1980 ~6\.0/);
    const input = validateSentenceRequest(table());
    assert.notEqual(
      sentenceCacheKey({
        promptVersion: "v1",
        model: "m",
        chartData: "a",
        ...input,
      }),
      sentenceCacheKey({
        promptVersion: "v1",
        model: "m",
        chartData: "b",
        ...input,
      }),
    );
  });
});
