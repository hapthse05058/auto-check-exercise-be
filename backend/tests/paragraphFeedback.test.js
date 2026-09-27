const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  IS_CORRECT_ANSWER,
  formatParagraphFeedback,
  gradeParagraphGroup,
  paragraphText,
  parseParagraphResponse,
} = require("../lib/paragraphFeedback.js");

const ok = (sentence, reason) => ({ sentence, reason });

describe("parseParagraphResponse", () => {
  const body =
    '{"items":[{"stt":1,"corrections":[]},{"stt":2,"corrections":[{"sentence":"A.","reason":"b"}]}]}';

  it("reads a bare JSON object", () => {
    const map = parseParagraphResponse(body);
    assert.deepEqual([...map.keys()], [1, 2]);
    assert.deepEqual(map.get(1), []);
  });

  it("reads JSON wrapped in a ```json fence and surrounding chatter", () => {
    const map = parseParagraphResponse(
      `Đây là kết quả:\n\`\`\`json\n${body}\n\`\`\`\nXong.`,
    );
    assert.deepEqual([...map.keys()], [1, 2]);
  });

  it("returns an empty map for broken JSON instead of throwing", () => {
    assert.equal(parseParagraphResponse('{"items":[{"stt":1,').size, 0);
    assert.equal(parseParagraphResponse("không có json").size, 0);
    assert.equal(parseParagraphResponse(undefined).size, 0);
  });

  it("drops an item whose corrections is not an array", () => {
    const map = parseParagraphResponse(
      '{"items":[{"stt":1},{"stt":2,"corrections":"none"},{"stt":3,"corrections":[]}]}',
    );
    assert.deepEqual([...map.keys()], [3]);
  });
});

describe("formatParagraphFeedback", () => {
  it("puts each reason on its own line and a blank line between sentences", () => {
    assert.equal(
      formatParagraphFeedback([
        ok("My name **is** Tom.", "S “My name” số ít → dùng “is” nhé."),
        ok("I **am** 18 years old.", "VL → Adj/N nhé."),
      ]),
      "My name **is** Tom.\n(S “My name” số ít → dùng “is” nhé.)\n\nI **am** 18 years old.\n(VL → Adj/N nhé.)",
    );
  });

  it("keeps a sentence with several errors as ONE block, every fix bold", () => {
    const text = formatParagraphFeedback([
      ok(
        "My favourite hobby **is playing** the guitar, but I **do** not **play** it very well.",
        "S “hobby” số ít → “is”; sau “is” dùng Ving; “do not + Vbare” nhé.",
      ),
    ]);
    assert.equal(text.split("\n\n").length, 1);
    assert.equal(text.split("\n").length, 2);
    assert.equal(text.match(/\*\*[^*]+\*\*/g).length, 3);
    assert.match(
      text,
      /\n\(S “hobby” số ít → “is”; sau “is” dùng Ving; “do not \+ Vbare” nhé\.\)$/,
    );
  });

  it("says ✅ Đúng for a paragraph with no mistakes", () => {
    assert.equal(formatParagraphFeedback([]), IS_CORRECT_ANSWER);
  });

  it("does not double the parentheses the model added itself", () => {
    assert.equal(
      formatParagraphFeedback([ok("A.", "(lý do nhé.)")]),
      "A.\n(lý do nhé.)",
    );
  });

  it("collapses a line break the model put inside a sentence or reason", () => {
    assert.equal(
      formatParagraphFeedback([
        ok("My name\n**is** Tom.", "S số ít\n→ is nhé."),
      ]),
      "My name **is** Tom.\n(S số ít → is nhé.)",
    );
  });

  it("returns null — never ✅ — for missing corrections", () => {
    assert.equal(formatParagraphFeedback(undefined), null);
    assert.equal(formatParagraphFeedback(null), null);
    assert.equal(formatParagraphFeedback("none"), null);
  });

  it("returns null for the WHOLE paragraph when one correction lacks a reason", () => {
    assert.equal(
      formatParagraphFeedback([
        ok("A **is** b.", "lý do nhé."),
        { sentence: "C **is** d." },
        ok("E **is** f.", "lý do nhé."),
      ]),
      null,
    );
  });

  it("returns null for a whitespace-only reason or an empty sentence", () => {
    assert.equal(formatParagraphFeedback([ok("A.", "   ")]), null);
    assert.equal(formatParagraphFeedback([ok("", "lý do nhé.")]), null);
    assert.equal(formatParagraphFeedback([ok("A.", "()")]), null);
    assert.equal(formatParagraphFeedback(["A. (lý do)"]), null);
  });
});

describe("paragraphText", () => {
  it("keeps the final period of every line and drops blank lines", () => {
    assert.equal(
      paragraphText("  My name is Tom.  \n\n\vI am 18.\r\n"),
      "My name is Tom.\nI am 18.",
    );
  });
});

describe("gradeParagraphGroup", () => {
  const group = [1, 2, 3].map((n) => ({
    question: `Chủ đề: Hobbies ${n}`,
    answer: `Đoạn văn ${n}.`,
  }));

  /** A callGrader that records what it was sent and replies with `reply`. */
  const grader = (reply) => {
    const sent = [];
    return {
      sent,
      callGrader: async (instruction, inputText, model) => {
        sent.push({ instruction, inputText, model });
        return reply;
      },
    };
  };

  it("numbers the items 1..k and sends them in one call", async () => {
    const g = grader('{"items":[]}');
    await gradeParagraphGroup(group, {
      instruction: "PROMPT",
      model: "m",
      callGrader: g.callGrader,
    });
    assert.equal(g.sent.length, 1);
    assert.equal(g.sent[0].instruction, "PROMPT");
    assert.equal(g.sent[0].model, "m");
    for (const n of [1, 2, 3]) {
      assert.match(
        g.sent[0].inputText,
        new RegExp(
          `\\[STT\\]: ${n}\\n\\[ĐỀ \\+ ĐOẠN MẪU\\]: Chủ đề: Hobbies ${n}\\n\\[ĐOẠN VĂN HỌC VIÊN\\]:\\nĐoạn văn ${n}\\.`,
        ),
      );
    }
  });

  it("gives null to the STT the model left out, and grades the others", async () => {
    const g = grader(
      JSON.stringify({
        items: [
          { stt: 1, corrections: [ok("A **is** b.", "lý do nhé.")] },
          { stt: 3, corrections: [] },
        ],
      }),
    );
    const feedback = await gradeParagraphGroup(group, {
      instruction: "P",
      model: "m",
      callGrader: g.callGrader,
    });
    assert.deepEqual(feedback, [
      "A **is** b.\n(lý do nhé.)",
      null,
      IS_CORRECT_ANSWER,
    ]);
  });

  it("gives null only to the item with a broken correction", async () => {
    const g = grader(
      JSON.stringify({
        items: [
          {
            stt: 1,
            corrections: [ok("A **is** b.", "lý do nhé."), { sentence: "C." }],
          },
          { stt: 2, corrections: [ok("D **is** e.", "lý do nhé.")] },
        ],
      }),
    );
    const feedback = await gradeParagraphGroup(group.slice(0, 2), {
      instruction: "P",
      model: "m",
      callGrader: g.callGrader,
    });
    assert.deepEqual(feedback, [null, "D **is** e.\n(lý do nhé.)"]);
  });

  it("gives null to every item when the reply is not JSON", async () => {
    const g = grader("Xin lỗi, tôi không chấm được.");
    const feedback = await gradeParagraphGroup(group, {
      instruction: "P",
      model: "m",
      callGrader: g.callGrader,
    });
    assert.deepEqual(feedback, [null, null, null]);
  });
});

describe("IS_CORRECT_ANSWER", () => {
  it("is the same mark the doc library writes and recognises", async () => {
    const { IS_CORRECT_ANSWER: fromDoc } =
      await import("../lib/doc/docParser.js");
    assert.equal(IS_CORRECT_ANSWER, fromDoc);
  });
});
