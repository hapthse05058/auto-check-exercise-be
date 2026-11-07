const assert = require("node:assert/strict");
const { describe, test, before } = require("node:test");

const {
  buildInput,
  createLmsExtraGrader,
  wordCheck,
} = require("../lib/lms/lmsExtraGrader.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");

let isCorrectFeedback;
before(async () => {
  ({ isCorrectFeedback } = await import("../lib/doc/docParser.js"));
});

/** A model that answers every [ID] in the input with `answerFor(item)`. */
function fakeAi(answerFor, { drop = new Set() } = {}) {
  const calls = [];
  const callAi = async (system, input) => {
    calls.push({ system, input });
    const ids = [...input.matchAll(/\[ID\]: (Q\d+)/g)].map((m) => m[1]);
    const answers = [...input.matchAll(/\[STUDENT_ANSWER\]: (.*)/g)].map(
      (m) => m[1],
    );
    const rows = ids
      .map((id, i) =>
        drop.has(answers[i]) && ids.length > 1
          ? null
          : `| ${id} | x | ${answers[i]} | ${answerFor(answers[i])} |`,
      )
      .filter(Boolean);
    return [
      "| STT | Đề | Bài làm | Chữa bài |",
      "|---|---|---|---|",
      ...rows,
    ].join("\n");
  };
  return { callAi, calls };
}

describe("wordCheck", () => {
  test("same words in another order: ok (case, punctuation ignored)", () => {
    const r = wordCheck(
      "novels / He / loves / stories / reads /, so / he /.",
      "He loves stories, so he reads novels.",
    );
    assert.equal(r.ok, true);
  });
  test("a misspelt, missing or extra word is reported", () => {
    const r = wordCheck(
      "drinks / milk, / She / is / it / healthy / for /.",
      "She drinks milk, for it is heathy very.",
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ["healthy"]);
    assert.deepEqual(r.extra, ["heathy", "very"]);
  });
});

describe("buildInput", () => {
  test("word order carries the given words and the machine word check", () => {
    const input = buildInput("word_order", [
      {
        question: "car / fastest / is / the / This / .",
        answer: "This car is fastest.",
        context: "",
      },
    ]);
    assert.match(input, /\[CÁC TỪ ĐÃ CHO\]: car \/ fastest/);
    assert.match(input, /\[KIỂM TRA TỪ\]: KHÔNG khớp.*the/);
  });
  test("spelling carries the group's rule", () => {
    const input = buildInput("spelling", [
      {
        question: "story",
        answer: "storys",
        context: "QUY TẮC 2: PHỤ ÂM + Y → IES\nCâu hỏi: …",
      },
    ]);
    assert.match(input, /\[QUY TẮC\]: QUY TẮC 2: PHỤ ÂM \+ Y → IES \/ Câu hỏi/);
    assert.match(input, /\[TỪ GỐC\]: story/);
  });
});

describe("grade", () => {
  const items = [
    {
      kind: "word_order",
      question: "speaks / Long / clearly / .",
      answer: "Long speaks clearly.",
      context: "",
    },
    {
      kind: "spelling",
      question: "story",
      answer: "Storys.",
      context: "QUY TẮC 2",
    },
    {
      kind: "spelling",
      question: "box",
      answer: "Boxes.",
      context: "QUY TẮC 1",
    },
  ];
  const answerFor = (a) =>
    a === "Storys." ? "**stories** (Phụ âm + y → ies.)" : "✅ Đúng";

  test("one call per kind, each with its own prompt; feedback aligned", async () => {
    const ai = fakeAi(answerFor);
    const grader = createLmsExtraGrader({
      callAi: ai.callAi,
      isCorrectFeedback,
    });
    const out = await grader.grade(items);
    assert.deepEqual(out, [
      "✅ Đúng",
      "**stories** (Phụ âm + y → ies.)",
      "✅ Đúng",
    ]);
    assert.equal(ai.calls.length, 2);
    assert.match(ai.calls[0].system, /Sắp xếp từ/);
    assert.match(ai.calls[1].system, /Chính tả/);
  });

  test("a word-order answer with the wrong words is never ✅, whatever the model says", async () => {
    const ai = fakeAi(() => "✅ Đúng");
    const grader = createLmsExtraGrader({
      callAi: ai.callAi,
      isCorrectFeedback,
    });
    const [fb] = await grader.grade([
      {
        kind: "word_order",
        question: "drinks / milk, / She / healthy / is / it / for / .",
        answer: "She drinks milk, for it is heathy.",
        context: "",
      },
    ]);
    assert.equal(isCorrectFeedback(fb), false);
    assert.match(
      fb,
      /Chưa dùng đúng các từ đã cho: thiếu healthy; thừa\/sai heathy/,
    );
  });

  test("a row the model dropped is graded again on its own", async () => {
    const ai = fakeAi(answerFor, { drop: new Set(["Boxes."]) });
    const grader = createLmsExtraGrader({
      callAi: ai.callAi,
      isCorrectFeedback,
    });
    const out = await grader.grade(items);
    assert.equal(out[2], "✅ Đúng");
    assert.equal(ai.calls.length, 3); // 2 groups + 1 retry
  });

  test("cached: the same answers are not sent twice; duplicates once", async () => {
    const db = new FakeFirestore();
    const ai = fakeAi(answerFor);
    const grader = createLmsExtraGrader({
      callAi: ai.callAi,
      db,
      isCorrectFeedback,
    });
    await grader.grade([...items, items[1]]);
    const firstCalls = ai.calls.length;
    const spellingInput = ai.calls.find((c) => /Chính tả/.test(c.system)).input;
    assert.equal(spellingInput.match(/Storys\./g).length, 1);
    const again = await grader.grade(items);
    assert.equal(ai.calls.length, firstCalls);
    assert.equal(again[1], "**stories** (Phụ âm + y → ies.)");
  });

  test("a misspelling is not cached as the right spelling (case-only is)", async () => {
    const db = new FakeFirestore();
    const ai = fakeAi(answerFor);
    const grader = createLmsExtraGrader({
      callAi: ai.callAi,
      db,
      isCorrectFeedback,
    });
    await grader.grade([items[1]]);
    const n = ai.calls.length;
    await grader.grade([{ ...items[1], answer: "storys." }]); // case only
    assert.equal(ai.calls.length, n);
    await grader.grade([{ ...items[1], answer: "Stories." }]); // different word
    assert.equal(ai.calls.length, n + 1);
  });
});
