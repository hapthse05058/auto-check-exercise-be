const assert = require("node:assert/strict");
const { describe, test, before } = require("node:test");

const L = require("../lib/lms/lmsItems.js");
const {
  applyDraft,
  assignment,
  deepCopy,
  doc,
  essay,
  heading,
  sessionPage,
} = require("./helpers/lmsFixtures.js");

let lib;
before(async () => {
  const [parser, writer] = await Promise.all([
    import("../lib/doc/docParser.js"),
    import("../lib/doc/docWriter.js"),
  ]);
  lib = { ...parser, ...writer };
});

/** Feedback the way the Basic prompt answers: ✅ Đúng, or a correction. */
const fakeFeedback = (answer) =>
  /good/.test(answer)
    ? "✅ Đúng"
    : "I **am learning** English now.\n(Sai thì.)";

function gradeAll(questions) {
  const map = new Map();
  for (const q of questions) {
    if (q.cls === L.QUESTION_CLASS.SUPPORTED)
      map.set(q.key, fakeFeedback(q.answer));
  }
  return map;
}

describe("tiptapToText", () => {
  test("paragraphs and hard breaks become lines", () => {
    const source = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "HTTD" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "B1:" },
            { type: "hardBreak" },
            { type: "text", marks: [{ type: "bold" }], text: "B2: " },
          ],
        },
        { type: "paragraph" },
      ],
    });
    assert.equal(L.tiptapToText(source), "HTTD\nB1:\nB2:");
  });
  test("plain (non-JSON) text is kept, empty stays empty", () => {
    assert.equal(L.tiptapToText("  just text "), "just text");
    assert.equal(L.tiptapToText(""), "");
    assert.equal(L.tiptapToText(null), "");
  });
});

/** The student submitted only the writing assignment. */
const WRITING_ONLY = { submittedIds: new Set(["1472"]) };

describe("itemsFromGrading — classification (R1)", () => {
  test("writing, word order and spelling are graded; nothing else", () => {
    const { targets } = L.itemsFromGrading(sessionPage());
    assert.deepEqual(
      targets.map((t) => [t.assignmentId, t.kind]),
      [
        [1472, "writing"],
        [1473, "word_order"],
        [1474, "spelling"],
      ],
    );
  });

  test("only the assignments the student submitted", () => {
    const { targets } = L.itemsFromGrading(sessionPage(), {
      submittedIds: new Set(["1472", "1474"]),
    });
    assert.deepEqual(
      targets.map((t) => t.assignmentId),
      [1472, 1474],
    );
  });

  test("word order / spelling questions carry their kind and rule text", () => {
    const { questions } = L.itemsFromGrading(sessionPage());
    const byId = Object.fromEntries(questions.map((q) => [q.questionId, q]));
    assert.equal(byId["q-o1"].kind, "word_order");
    assert.equal(byId["q-o1"].cls, "supported");
    assert.equal(byId["q-s1"].kind, "spelling");
    assert.match(byId["q-s1"].context, /PHỤ ÂM \+ Y → IES/);
    assert.match(byId["q-s1"].context, /Hãy thêm/);
  });

  test("formula rows excluded, blank answers blank, the rest supported", () => {
    const { questions, counts } = L.itemsFromGrading(
      sessionPage(),
      WRITING_ONLY,
    );
    assert.deepEqual(counts, {
      supported: 4,
      blank: 1,
      excluded: 2,
      uncertain: 0,
    });
    const byId = Object.fromEntries(questions.map((q) => [q.questionId, q]));
    assert.equal(byId["q-f1"].cls, "excluded");
    assert.equal(byId["q-f2"].cls, "excluded");
    assert.equal(byId["q-w5"].cls, "blank");
    assert.equal(byId["q-w1"].section, "HTĐ");
    assert.equal(byId["q-w4"].section, "DANH TỪ SỐ ÍT SANG SỐ NHIỀU");
    assert.equal(byId["q-w1"].taskType, "vi_en");
  });

  test("a formula row outside a 'Thành lập' group is still excluded", () => {
    const page = [
      assignment({
        assignmentId: 1,
        name: "BÀI TẬP VIẾT CÂU",
        groups: [
          {
            rows: [
              essay(1, "HTHTTD\nB1:\nB2:", "have been Ving"),
              essay(2, "QKĐ", "V-ed"),
              essay(3, "Tôi đi học.", "I go to school."),
            ],
          },
        ],
      }),
    ];
    const { counts } = L.itemsFromGrading(page);
    assert.deepEqual(counts, {
      supported: 1,
      blank: 0,
      excluded: 2,
      uncertain: 0,
    });
  });

  test("a question with only media is uncertain, never sent", () => {
    const page = [
      assignment({
        assignmentId: 1,
        name: "BÀI TẬP VIẾT CÂU",
        groups: [
          {
            rows: [
              essay(1, "", "Some answer", {
                content: [{ id: "img", type: 1, source: "https://x/img.png" }],
              }),
            ],
          },
        ],
      }),
    ];
    const { questions } = L.itemsFromGrading(page);
    assert.equal(questions[0].cls, "uncertain");
    assert.equal(questions[0].reason, "mediaOnly");
  });

  test("an active→passive heading sets the task type", () => {
    const page = [
      assignment({
        assignmentId: 1,
        name: "BÀI TẬP VIẾT CÂU",
        groups: [
          {
            rows: [
              heading("Chuyển câu chủ động sang bị động"),
              essay(1, "She cleans the room.", "The room is cleaned by her."),
            ],
          },
        ],
      }),
    ];
    assert.equal(
      L.itemsFromGrading(page).questions[0].taskType,
      "active_passive",
    );
  });

  test("questions are keyed assignmentId:questionId (R3)", () => {
    const { questions } = L.itemsFromGrading(sessionPage());
    assert.equal(
      questions.find((q) => q.questionId === "q-w1").key,
      "1472:q-w1",
    );
  });
});

describe("scoreOf (R2)", () => {
  const cases = [
    [0, 1],
    [39, 1],
    [40, 2],
    [59, 2],
    [60, 3],
    [79, 3],
    [80, 4],
    [99, 4],
    [100, 5],
  ];
  for (const [pct, score] of cases) {
    test(`${pct}% → ${score}`, () => assert.equal(L.scoreOf(pct, 100), score));
  }
  test("no counted question → no score", () => {
    assert.equal(L.scoreOf(0, 0), null);
  });
  test("small denominators at the thresholds", () => {
    assert.equal(L.scoreOf(6, 10), 3);
    assert.equal(L.scoreOf(4, 5), 4);
    assert.equal(L.scoreOf(2, 5), 2);
  });
});

describe("verdictsOf", () => {
  test("blank answers count as wrong in the denominator", () => {
    // 10 questions: 6 right, 2 wrong, 2 blank → 6/10 → 3.
    const rows = [];
    for (let i = 1; i <= 10; i++) {
      const answer = i <= 6 ? "right good" : i <= 8 ? "wrong" : null;
      rows.push(essay(i, `Câu ${i}.`, answer));
    }
    const page = [
      assignment({
        assignmentId: 5,
        name: "BÀI TẬP VIẾT CÂU",
        groups: [{ rows }],
      }),
    ];
    const { questions } = L.itemsFromGrading(page);
    const r = L.verdictsOf(questions, gradeAll(questions), lib);
    assert.equal(r.counted, 10);
    assert.equal(r.correct, 6);
    assert.equal(r.score, 3);
    const blank = questions.find((q) => q.cls === "blank");
    assert.deepEqual(r.verdicts.get(blank.key), {
      review: "Chưa làm",
      isCorrect: false,
    });
  });

  test("all correct → 5 and the 'làm tốt' comment", () => {
    const page = sessionPage({
      answers: ["a good", "b good", "c good", "d good", "e good"],
    });
    const { questions } = L.itemsFromGrading(page, WRITING_ONLY);
    const r = L.verdictsOf(questions, gradeAll(questions), lib);
    assert.equal(r.score, 5);
    assert.match(r.overall, /Làm tốt lắm/);
  });

  test("the score counts every graded assignment together", () => {
    // Writing 3/5 (1 blank) + word order wrong + spelling right → 4/7 → 2.
    const { questions } = L.itemsFromGrading(sessionPage());
    const r = L.verdictsOf(questions, gradeAll(questions), lib);
    assert.equal(r.counted, 7);
    assert.equal(r.correct, 4);
    assert.equal(r.score, 2);
  });

  test("a missing feedback is an error, not a silent pass", () => {
    const { questions } = L.itemsFromGrading(sessionPage());
    const r = L.verdictsOf(questions, new Map(), lib);
    assert.equal(r.error, "missingFeedback");
  });
});

describe("buildDraftPayload", () => {
  function graded(page = sessionPage(), opts = WRITING_ONLY) {
    const { questions, targets } = L.itemsFromGrading(page, opts);
    const result = L.verdictsOf(questions, gradeAll(questions), lib);
    result.assignmentIds = targets.map((t) => String(t.assignmentId));
    return result;
  }
  const NOW = Date.UTC(2026, 10, 6, 3, 0, 0); // 10:00 Vietnam time

  test("only the graded assignments are sent, all with the shared score", () => {
    const page = sessionPage();
    const body = L.buildDraftPayload(page, graded(page, {}), { now: NOW });
    assert.deepEqual(
      body.map((b) => b.assignmentId),
      [1472, 1473, 1474],
    );
    assert.ok(body.every((b) => b.score === 2 && b.review === body[0].review));
    const order = body[1].questionReviews[0];
    assert.equal(order.isCorrect, 0);
    assert.match(L.tiptapToText(order.review), /Sai thì/);
  });

  test("default: only the writing assignment is sent", () => {
    const page = sessionPage();
    const body = L.buildDraftPayload(page, graded(page), { now: NOW });
    assert.deepEqual(
      body.map((b) => b.assignmentId),
      [1472],
    );
    const reviews = Object.fromEntries(
      body[0].questionReviews.map((r) => [r.questionId, r]),
    );
    // Formula rows: untouched.
    assert.equal(reviews["q-f1"].review, "");
    // Graded rows: tiptap review, verdict, timestamp in LMS format.
    assert.equal(L.tiptapToText(reviews["q-w1"].review), "✅ Đúng");
    assert.equal(reviews["q-w1"].isCorrect, 1);
    assert.equal(reviews["q-w3"].isCorrect, 0);
    assert.equal(reviews["q-w5"].isCorrect, 0);
    assert.equal(L.tiptapToText(reviews["q-w5"].review), "Chưa làm");
    assert.equal(reviews["q-w1"].gradedAt, "2026-11-06 10:00:00");
    assert.equal(reviews["q-w1"].gradingLateFlag, false);
    // 3 right of 5 counted (1 blank) → 60% → 3.
    assert.equal(body[0].score, 3);
    // Headings are never part of questionReviews.
    assert.equal(body[0].questionReviews.length, 7);
  });

  test("Test A: other assignments are echoed unchanged", () => {
    const page = sessionPage();
    const original = deepCopy(page);
    const body = L.buildDraftPayload(page, graded(page), {
      now: NOW,
      onlyTargets: false,
      shareOverall: false,
    });
    assert.deepEqual(
      body.map((b) => b.assignmentId),
      [1472, 1473, 1474, 1476, 1475],
    );
    for (const entry of body.slice(1)) {
      const before = original.find(
        (a) => a.assignmentId === entry.assignmentId,
      );
      assert.equal(entry.score, before.score);
      assert.equal(entry.review, before.review);
      const questions = before.gradingList.questionGroupList.flatMap((g) =>
        g.questionGroup.flatMap((qg) =>
          qg.questionList.filter((q) => q.type !== 3),
        ),
      );
      assert.equal(entry.questionReviews.length, questions.length);
      for (const r of entry.questionReviews) {
        const q = questions.find((x) => x.id === r.questionId);
        assert.equal(r.review, q.review);
        assert.equal(
          r.isCorrect,
          q.selectedAnswer?.[0]?.isCorrect === 1 ? 1 : 0,
        );
      }
    }
    // Applying it changes nothing outside the writing assignment, bar two
    // notations the LMS's own UI also normalises: dates "…T10:00:00" →
    // "… 10:00:00", and an unset isCorrect (null) → 0.
    applyDraft(page, body);
    const normalise = (v) =>
      JSON.parse(
        JSON.stringify(v)
          .replace(/(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)"/g, '$1 $2"')
          .replace(/"isCorrect":null/g, '"isCorrect":0'),
      );
    assert.deepEqual(normalise(page.slice(1)), normalise(original.slice(1)));
  });

  test("shareOverall gives every sent assignment the same score/review", () => {
    const page = sessionPage();
    const body = L.buildDraftPayload(page, graded(page), {
      now: NOW,
      onlyTargets: false,
      shareOverall: true,
    });
    assert.ok(body.every((b) => b.score === 3));
    assert.ok(body.every((b) => b.review === body[0].review));
  });

  test("past the check deadline the written rows are flagged late", () => {
    const page = sessionPage();
    const late = Date.UTC(2026, 10, 20);
    const body = L.buildDraftPayload(page, graded(page), { now: late });
    const r = body[0].questionReviews.find((x) => x.questionId === "q-w1");
    assert.equal(r.gradingLateFlag, true);
  });

  test("bold markers become bold marks, lines become paragraphs", () => {
    const json = JSON.parse(
      L.reviewToTiptap("I **am learning** English now.\n(Sai thì.)"),
    );
    assert.equal(json.content.length, 2);
    assert.deepEqual(json.content[0].content[1], {
      type: "text",
      marks: [{ type: "bold" }],
      text: "am learning",
    });
  });
});

describe("hashes (R6)", () => {
  test("the draft hash matches the reviews once the LMS stored the draft", () => {
    const page = sessionPage();
    const { questions } = L.itemsFromGrading(page);
    const result = L.verdictsOf(questions, gradeAll(questions), lib);
    const keys = [...result.verdicts.keys()];
    const before = L.hashReviews(page, keys);
    applyDraft(page, L.buildDraftPayload(page, result, { now: Date.now() }));
    assert.equal(L.hashReviews(page, keys), L.hashDraft(page, result));
    assert.notEqual(before, L.hashDraft(page, result));
  });

  test("a teacher edit of one review changes the hash", () => {
    const page = sessionPage();
    const keys = ["1472:q-w1"];
    const before = L.hashReviews(page, keys);
    page[0].gradingList.questionGroupList[2].questionGroup[0].questionList[1].review =
      doc("Cô sửa");
    assert.notEqual(L.hashReviews(page, keys), before);
  });

  test("answers: an edit changes the hash, JSON key order does not", () => {
    const page = sessionPage();
    const h = L.hashAnswers(page);
    const reordered = deepCopy(page);
    const q =
      reordered[0].gradingList.questionGroupList[2].questionGroup[0]
        .questionList[1];
    const parsed = JSON.parse(q.selectedAnswer[0].content[0].source);
    q.selectedAnswer[0].content[0].source = JSON.stringify({
      content: parsed.content,
      type: parsed.type,
    });
    assert.equal(L.hashAnswers(reordered), h);
    q.selectedAnswer[0].content[0].source = doc("I study English everyday!");
    assert.notEqual(L.hashAnswers(reordered), h);
  });

  test("other assignments' answers are not part of the fingerprint", () => {
    const page = sessionPage();
    const h = L.hashAnswers(page);
    // "BÀI TẬP NGHE" is never graded.
    page[3].gradingList.questionGroupList[0].questionGroup[0].questionList[0].selectedAnswer[0].content[0].source =
      doc("changed");
    assert.equal(L.hashAnswers(page), h);
  });

  test("a per-assignment hash ignores the other graded assignments", () => {
    const page = sessionPage();
    const writing = L.hashAnswers(page, ["1472"]);
    const all = L.hashAnswers(page);
    page[1].gradingList.questionGroupList[0].questionGroup[0].questionList[0].selectedAnswer[0].content[0].source =
      doc("Clearly Long speaks.");
    assert.equal(L.hashAnswers(page, ["1472"]), writing);
    assert.notEqual(L.hashAnswers(page), all);
  });
});

describe("reusing our own review", () => {
  test("bold survives a round trip through the LMS", () => {
    const text = "I **am learning** English **now**.\n(Sai thì HTTD.)";
    assert.equal(
      L.tiptapToText(L.reviewToTiptap(text), { markBold: true }),
      text,
    );
  });
});
