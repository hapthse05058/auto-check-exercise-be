const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  IS_CORRECT_ANSWER,
  PARAGRAPH_ALL_CORRECT,
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
      "My name **is** Tom.\n(S “My name” số ít → dùng “is”.)\n\nI **am** 18 years old.\n(VL → Adj/N.)",
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
      /\n\(S “hobby” số ít → “is”; sau “is” dùng Ving; “do not \+ Vbare”\.\)$/,
    );
  });

  it("says the teachers' all-correct sentence for a paragraph with no mistakes", () => {
    assert.equal(formatParagraphFeedback([]), PARAGRAPH_ALL_CORRECT);
    assert.equal(PARAGRAPH_ALL_CORRECT, "Các câu đúng hết rồi nha! ^^");
  });

  it("drops “nhé” at the end of every point, and spells Pii", () => {
    assert.equal(
      formatParagraphFeedback([
        ok("A **is** b.", "S số ít → “is” nhé; be + PII nhé!"),
        ok("C.", "Phải NTNS ngay nhé"),
      ]),
      "A **is** b.\n(S số ít → “is”; be + Pii!)\n\nC.\n(Phải NTNS ngay)",
    );
  });

  it("does not double the parentheses the model added itself", () => {
    assert.equal(
      formatParagraphFeedback([ok("A.", "(lý do nhé.)")]),
      "A.\n(lý do.)",
    );
  });

  it("collapses a line break the model put inside a sentence or reason", () => {
    assert.equal(
      formatParagraphFeedback([
        ok("My name\n**is** Tom.", "S số ít\n→ is nhé."),
      ]),
      "My name **is** Tom.\n(S số ít → is.)",
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
  const deps = (callGrader, extra = {}) => ({
    instruction: "P",
    model: "m",
    callGrader,
    ...extra,
  });
  const reply = (...items) => JSON.stringify({ items });
  const allCorrect = (stt) => ({ stt, corrections: [] });

  /**
   * A callGrader that records what it was sent and answers with `replies` in
   * turn (the last one from then on). A reply that is an Error is thrown.
   */
  const grader = (...replies) => {
    const sent = [];
    return {
      sent,
      callGrader: async (instruction, inputText, model) => {
        sent.push({ instruction, inputText, model });
        const next = replies[Math.min(sent.length, replies.length) - 1];
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  /** Which paragraphs ("Đoạn văn N.") a call carried. */
  const carried = ({ inputText }) =>
    [...inputText.matchAll(/Đoạn văn (\d)\./g)].map((m) => Number(m[1]));

  it("numbers the items 1..k and sends them in one call", async () => {
    const g = grader(reply(allCorrect(1), allCorrect(2), allCorrect(3)));
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

  it("asks again, alone, for the STT the model left out", async () => {
    const g = grader(
      reply(
        { stt: 1, corrections: [ok("A **is** b.", "lý do nhé.")] },
        allCorrect(3),
      ),
      reply({ stt: 1, corrections: [ok("X **is** y.", "vì thế.")] }),
    );
    const feedback = await gradeParagraphGroup(group, deps(g.callGrader));
    assert.deepEqual(feedback, [
      "A **is** b.\n(lý do.)",
      "X **is** y.\n(vì thế.)",
      PARAGRAPH_ALL_CORRECT,
    ]);
    // The second call carried paragraph 2 only, numbered 1.
    assert.equal(g.sent.length, 2);
    assert.deepEqual(carried(g.sent[1]), [2]);
    assert.match(g.sent[1].inputText, /\[STT\]: 1\n/);
    assert.doesNotMatch(g.sent[1].inputText, /\[STT\]: 2\n/);
  });

  it("asks again for the item with a broken correction, keeps the others", async () => {
    const g = grader(
      reply(
        {
          stt: 1,
          corrections: [ok("A **is** b.", "lý do nhé."), { sentence: "C." }],
        },
        { stt: 2, corrections: [ok("D **is** e.", "lý do nhé.")] },
      ),
      reply({
        stt: 1,
        corrections: [ok("A **is** b.", "lý do."), ok("C **was** d.", "thì.")],
      }),
    );
    const feedback = await gradeParagraphGroup(
      group.slice(0, 2),
      deps(g.callGrader),
    );
    assert.deepEqual(feedback, [
      "A **is** b.\n(lý do.)\n\nC **was** d.\n(thì.)",
      "D **is** e.\n(lý do.)",
    ]);
    assert.deepEqual(g.sent.map(carried), [[1, 2], [1]]);
  });

  it("leaves null what is still unusable after the single re-grade", async () => {
    const g = grader("Xin lỗi, tôi không chấm được.");
    const feedback = await gradeParagraphGroup(group, deps(g.callGrader));
    assert.deepEqual(feedback, [null, null, null]);
    // One call for the group, then one per item — and no more.
    assert.equal(g.sent.length, 4);
    assert.deepEqual(g.sent.slice(1).map(carried).sort(), [[1], [2], [3]]);
  });

  it("reports a failed re-grade and keeps the paragraphs already graded", async () => {
    const boom = Object.assign(new Error("429 Too many requests"), {
      status: 429,
    });
    const g = grader(reply(allCorrect(1), allCorrect(3)), boom);
    const failures = [];
    const feedback = await gradeParagraphGroup(
      group,
      deps(g.callGrader, { onFailure: (err) => failures.push(err) }),
    );
    assert.deepEqual(feedback, [
      PARAGRAPH_ALL_CORRECT,
      null,
      PARAGRAPH_ALL_CORRECT,
    ]);
    assert.deepEqual(failures, [boom]);
  });

  it("throws when the call for the whole group fails", async () => {
    const boom = new TypeError("terminated");
    const g = grader(boom);
    await assert.rejects(
      gradeParagraphGroup(group, deps(g.callGrader)),
      /terminated/,
    );
    assert.equal(g.sent.length, 1);
  });
});

describe("IS_CORRECT_ANSWER", () => {
  it("is the same mark the doc library writes and recognises", async () => {
    const { IS_CORRECT_ANSWER: fromDoc } =
      await import("../lib/doc/docParser.js");
    assert.equal(IS_CORRECT_ANSWER, fromDoc);
  });

  it("PARAGRAPH_ALL_CORRECT matches the doc library, which counts it as right", async () => {
    const doc = await import("../lib/doc/docParser.js");
    assert.equal(PARAGRAPH_ALL_CORRECT, doc.PARAGRAPH_ALL_CORRECT);
    assert.ok(doc.isCorrectFeedback(PARAGRAPH_ALL_CORRECT));
  });
});
