const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  buildSentenceInput,
  correctionFitsAnswer,
  echoMatches,
  matchGradedRows,
  normalizeId,
  parseGradedRows,
} = require("../lib/basicRows.js");
const { gradingCacheKey } = require("../lib/gradingKey.js");

const HEADER =
  "| STT | Câu tiếng Việt | Câu trả lời của học sinh | Chữa bài |\n| --- | --- | --- | --- |";
const table = (...rows) =>
  [HEADER, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const ALTHOUGH = {
  question: "4. Mặc dù trời mưa rất to, nhưng họ vẫn ra ngoài.",
  answer: "Although it rains very heavily, they still go out.",
};
const IF_SEC = {
  question: "15. Nếu tôi học tiếng Anh ở SEC 1 năm trước, tôi sẽ nói được.",
  answer:
    "If I had studied English at SEC one year ago, I would be able to speak English.",
};

describe("buildSentenceInput", () => {
  it("sends ids, never the question's own number", () => {
    const text = buildSentenceInput([
      ALTHOUGH,
      { ...IF_SEC, section: "Câu điều kiện loại 3" },
    ]);
    assert.match(text, /\[ID\]: Q1\n\[VIETNAMESE\]: Mặc dù trời mưa/);
    assert.match(
      text,
      /\[ID\]: Q2\n\[CHỦ ĐIỂM\]: Câu điều kiện loại 3\n\[VIETNAMESE\]: Nếu tôi/,
    );
    assert.doesNotMatch(text, /\[VIETNAMESE\]: \d/);
  });

  it("labels an active→passive item as such", () => {
    const text = buildSentenceInput([
      {
        question: "1. The teacher checks the lesson.",
        answer: "The lesson is checked by the teacher.",
        taskType: "active_passive",
      },
    ]);
    assert.match(
      text,
      /\[ID\]: Q1\n\[TASK\]: ACTIVE_TO_PASSIVE\n\[ACTIVE_SENTENCE\]: The teacher/,
    );
  });
});

describe("parseGradedRows", () => {
  it("reads ids in any spelling and joins a feedback split by '|'", () => {
    const rows = parseGradedRows(
      table(
        ["Q1", "a", "→ x", "✅ Đúng"],
        ["q 2", "b", "y", "A | B"],
        ["3", "c", "z", "fix"],
        ["Ghi chú", "d", "w", "ignored"],
      ),
    );
    assert.deepEqual(
      rows.map((r) => [r.id, r.feedback]),
      [
        ["Q1", "✅ Đúng"],
        ["Q2", "A | B"],
        ["Q3", "fix"],
      ],
    );
  });

  it("spells the past participle Pii", () => {
    const [row] = parseGradedRows(
      table(["Q1", "a", "I have know", "I have **known**. (HTHT: have + PII)"]),
    );
    assert.equal(row.feedback, "I have **known**. (HTHT: have + Pii)");
  });

  it("normalizes ids", () => {
    assert.equal(normalizeId(" Q07 "), "Q7");
    assert.equal(normalizeId("STT"), null);
  });
});

describe("row checks", () => {
  it("rejects the two misplaced corrections teachers reported", () => {
    // Item 4 got the prompt's reference answer of question 2 (Buổi 22), item
    // 15 the one of question 19.
    assert.equal(
      correctionFitsAnswer(
        "I will try my best **to study hard** so that I can pass the exam. (Dịch 'học hành chăm chỉ' là 'study hard'.)",
        ALTHOUGH.answer,
      ),
      false,
    );
    assert.equal(
      correctionFitsAnswer(
        "When **called**, he answered quickly. (Rút gọn mệnh đề trạng ngữ: bỏ 'was'.)",
        IF_SEC.answer,
      ),
      false,
    );
  });

  it("accepts real corrections, verdicts and too-short answers", () => {
    assert.ok(
      correctionFitsAnswer(
        "I **am going to** visit you tomorrow. (Dùng be going to cho dự định.)",
        "I will visit my friend tomorrow",
      ),
    );
    assert.ok(correctionFitsAnswer("✅ Đúng", ALTHOUGH.answer));
    assert.ok(
      correctionFitsAnswer(
        "Câu đơn: ✅ Đúng Câu phức đúng là: The man **who** is wearing a black hat is my teacher. (DCadj đứng sau N.)",
        "Câu đơn: The man is my teacher. He is wearing a black hat.\nCâu phức: The man is wearing a black hat is my teacher.",
      ),
    );
    assert.ok(correctionFitsAnswer("I **like** dogs.", "I likes"));
  });

  it("checks the echo of the answer", () => {
    assert.ok(echoMatches("→ I goes home.", "I goes home"));
    assert.equal(echoMatches("I goes home every day", "She do it"), false);
    assert.equal(echoMatches("I goes home every day", ""), false);
  });

  it("keeps good rows and isolates bad ones", () => {
    const group = [
      { question: "1. Tôi về nhà.", answer: "I goes home every day" },
      ALTHOUGH,
      IF_SEC,
      { question: "Câu 4", answer: "She do it every day" },
      { question: "Câu 5", answer: "They plays football now" },
    ];
    const { feedbacks, rejected } = matchGradedRows(
      group,
      parseGradedRows(
        table(
          [
            "Q1",
            "Tôi về nhà.",
            "I goes home every day",
            "I **go** home every day.",
          ],
          [
            "Q2",
            "x",
            ALTHOUGH.answer,
            "I will try my best to study hard so that I can pass the exam.",
          ],
          ["Q3", "x", "She do it", "She **does** it."],
          ["Q4", "x", "She do it every day", "She **does** it every day."],
          ["Q4", "x", "She do it every day", "✅ Đúng"],
        ),
      ),
    );
    assert.deepEqual(feedbacks, [
      "I **go** home every day.",
      null,
      null,
      null,
      null,
    ]);
    assert.deepEqual(rejected, [
      { index: 1, reason: "mismatch" },
      { index: 2, reason: "echo" },
      { index: 3, reason: "duplicate" },
      { index: 4, reason: "missing" },
    ]);
  });
});

describe("an item graded on its own", () => {
  it("keeps a correction for an answer to another question (no fit check)", () => {
    const group = [
      {
        question: "Không khí ở Đà Lạt trong lành và sạch sẽ",
        answer: "Water is very good for your health",
      },
    ];
    const rows = parseGradedRows(
      table([
        "Q1",
        "x",
        "Water is very good for your health",
        "**The air in Da Lat is fresh and clean.** (Câu trả lời lạc đề.)",
      ]),
    );
    assert.deepEqual(matchGradedRows(group, rows).rejected, [
      { index: 0, reason: "mismatch" },
    ]);
    const alone = matchGradedRows(group, rows, { checkFit: false });
    assert.deepEqual(alone.rejected, []);
    assert.match(alone.feedbacks[0], /Da Lat/);
  });
});

describe("gradingCacheKey section", () => {
  const key = (section) =>
    gradingCacheKey(
      "v1",
      "m",
      "Tôi sẽ đá bóng.",
      "I will play",
      "vi_en",
      section,
    );

  it("keeps the old key when there is no section", () => {
    assert.equal(
      key(undefined),
      gradingCacheKey("v1", "m", "Tôi sẽ đá bóng.", "I will play", "vi_en"),
    );
    assert.equal(key(""), key(undefined));
    assert.equal(key("  "), key(undefined));
  });

  it("splits the same Q/A under two headings", () => {
    assert.notEqual(key("Be going to"), key(undefined));
    assert.notEqual(key("Be going to"), key("Will"));
    assert.equal(key(" Be  going to "), key("Be going to"));
  });
});
