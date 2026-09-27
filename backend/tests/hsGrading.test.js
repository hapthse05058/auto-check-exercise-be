/**
 * lib/hsGrading.js — the HS grader: answer-key shortcut, listening rule,
 * batched model calls that are used only when complete and valid (never
 * merged across attempts), and its own cache collection.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  BATCH_SIZE,
  CACHE_COLLECTION,
  createHsGrader,
  decideFromKey,
  hsItemIdentity,
  normalizeAnswer,
  parseBatchAnswer,
} = require("../lib/hsGrading.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");

const blank = (key, fills, extra = {}) => ({
  key,
  lessonId: "hsLesson07",
  exerciseId: "ex2",
  kind: "blank",
  instruction: "Write the correct form of the verb.",
  prompt: "My friend often ____ (study) in the library.",
  answer: {
    fills,
    sentence: `My friend often ${fills.join(" ")} (study) in the library.`,
  },
  ...extra,
});
const line = (key, answer) => ({
  key,
  lessonId: "hsLesson19",
  exerciseId: "ex2",
  kind: "line",
  instruction: "There is a mistake in each sentence.",
  prompt: `${key} → `,
  answer,
});

/** A model that answers from `reply(ids, attempt)` and records its calls. */
function fakeModel(reply) {
  const calls = [];
  return {
    calls,
    async callModel(instruction, content, model) {
      calls.push({ instruction, content: JSON.parse(content), model });
      const ids = JSON.parse(content).exercises.flatMap((e) =>
        e.items.map((i) => i.id),
      );
      return reply(ids, calls.length);
    },
  };
}
const allCorrect = (ids) =>
  JSON.stringify({ items: ids.map((id) => ({ id, correct: true })) });

function grader(model, { answerKey, db = new FakeFirestore() } = {}) {
  return {
    db,
    grader: createHsGrader({
      db,
      callModel: model.callModel,
      readPrompt: () => "HS-PROMPT",
      model: "m",
      promptVersion: "v1",
      answerKey,
      now: () => 1,
      log: () => {},
    }),
  };
}

const KEY = {
  entries: {
    k1: { answers: ["studies"], source: "ai_draft_approved" },
    k2: {
      answers: ["doesn't have", "does not have"],
      source: "teacher_verified",
    },
    draft: { answers: ["studies"], source: "ai_draft" },
    b3: { answers: ["room"], source: "teacher_verified" },
    two: { answers: ["study | will pass"], source: "ai_draft_approved" },
  },
};

describe("answer key shortcut (no model call)", () => {
  it("is correct when the answer is one of the approved answers", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g } = grader(model, { answerKey: KEY });
    const items = [
      blank("k1", ["studies"]),
      blank("k2", ["does not have"]), // an accepted alternative
      blank("k2", ["  Doesn’t   HAVE. "]), // case, quotes, spaces, full stop
      blank("two", ["Study", "will  pass"]), // two blanks
    ];
    const out = await g.grade(items);
    for (const item of items) {
      assert.deepEqual(out.get(hsItemIdentity(item)), {
        verdict: { correct: true },
        source: "key",
      });
    }
    assert.equal(model.calls.length, 0);
  });

  it("asks the model when the answer is not in the key (it may still be right)", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g } = grader(model, { answerKey: KEY });
    const item = blank("k1", ["study"]);
    const out = await g.grade([item]);
    assert.equal(model.calls.length, 1);
    assert.equal(out.get(hsItemIdentity(item)).source, "model");
    // …with the key as a reference.
    assert.deepEqual(model.calls[0].content.exercises[0].items[0].key, [
      "studies",
    ]);
  });

  it("never short-cuts on an unapproved draft", () => {
    assert.equal(
      decideFromKey(blank("draft", ["studies"]), KEY.entries.draft),
      null,
    );
  });

  it("does not short-cut sentence answers, only blanks", () => {
    assert.equal(
      decideFromKey(line("k1", "studies"), {
        answers: ["studies"],
        source: "teacher_verified",
      }),
      null,
    );
  });

  it("normalises only case, quotes, spaces and end punctuation", () => {
    assert.equal(normalizeAnswer(" Doesn’t  have. "), "doesn't have");
    assert.equal(normalizeAnswer("a|b"), "a | b");
    assert.notEqual(normalizeAnswer("an"), normalizeAnswer("a"));
  });
});

describe("listening (Buổi 03): never sent to the model", () => {
  const listen = (key, answer) => ({
    key,
    lessonId: "hsLesson03",
    exerciseId: "ex2",
    kind: "listening",
    prompt: "Emma: What is your ____ like, Ben?",
    slot: 0,
    answer,
  });

  it("right → correct; wrong → wrong against the key", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g } = grader(model, { answerKey: KEY });
    const right = listen("b3", "Room");
    const wrong = listen("b3", "house");
    const out = await g.grade([right, wrong]);
    assert.deepEqual(out.get(hsItemIdentity(right)).verdict, { correct: true });
    assert.deepEqual(out.get(hsItemIdentity(wrong)).verdict, {
      correct: false,
      expected: "room",
    });
    assert.equal(model.calls.length, 0);
  });

  it("without an approved key: skipped with hsKeyMissing, not guessed", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g } = grader(model, { answerKey: KEY });
    const item = listen("nokey", "hall");
    const out = await g.grade([item]);
    assert.deepEqual(out.get(hsItemIdentity(item)), {
      verdict: null,
      warning: "hsKeyMissing",
      source: "none",
    });
    assert.equal(model.calls.length, 0);
  });
});

describe("model answers: complete and valid, or not used at all", () => {
  const items = [line("a", "x"), line("b", "y"), line("c", "z")];

  it("parses a valid answer; a wrong item needs a correction", () => {
    const ok = parseBatchAnswer(
      '```json\n{"items":[{"id":"1","correct":true},{"id":"2","correct":false,"corrected":"B.","explanation":"vì nhé"}]}\n```',
      ["1", "2"],
    );
    assert.deepEqual(ok.get("2"), {
      correct: false,
      corrected: "B.",
      explanation: "vì nhé",
    });
    for (const bad of [
      '{"items":[{"id":"1","correct":true}]}', // missing id 2
      '{"items":[{"id":"1","correct":true},{"id":"1","correct":true}]}', // duplicate
      '{"items":[{"id":"1","correct":true},{"id":"9","correct":true}]}', // unknown id
      '{"items":[{"id":"1","correct":"yes"},{"id":"2","correct":true}]}', // not boolean
      '{"items":[{"id":"1","correct":false},{"id":"2","correct":true}]}', // no correction
      "not json",
    ]) {
      assert.equal(parseBatchAnswer(bad, ["1", "2"]), null, bad);
    }
  });

  it("malformed first answer → the second one is used, whole", async () => {
    const model = fakeModel((ids, attempt) =>
      attempt === 1
        ? "oops"
        : JSON.stringify({
            items: ids.map((id) => ({
              id,
              correct: id !== "2",
              corrected: "Fix.",
            })),
          }),
    );
    const { grader: g } = grader(model);
    const out = await g.grade(items);
    assert.equal(model.calls.length, 2);
    assert.deepEqual(
      items.map((i) => out.get(hsItemIdentity(i)).verdict.correct),
      [true, false, true],
    );
  });

  it("an incomplete first answer is dropped, NOT merged with the second", async () => {
    const model = fakeModel((ids, attempt) =>
      attempt === 1
        ? JSON.stringify({
            items: [{ id: "1", correct: false, corrected: "FROM-ATTEMPT-1" }],
          })
        : allCorrect(ids),
    );
    const { grader: g } = grader(model);
    const out = await g.grade(items);
    assert.deepEqual(
      items.map((i) => out.get(hsItemIdentity(i)).verdict),
      [{ correct: true }, { correct: true }, { correct: true }],
    );
  });

  it("two bad answers → every item of the batch is ungraded (hsAiInvalid)", async () => {
    const model = fakeModel(() => '{"items":[]}');
    const { grader: g, db } = grader(model);
    const out = await g.grade(items);
    assert.equal(model.calls.length, 2);
    for (const i of items) {
      assert.deepEqual(out.get(hsItemIdentity(i)), {
        verdict: null,
        warning: "hsAiInvalid",
        source: "none",
      });
    }
    assert.deepEqual(db.dump(CACHE_COLLECTION), {}); // nothing cached
  });

  it("a thrown model error counts as a failed attempt", async () => {
    let n = 0;
    const model = {
      calls: [],
      async callModel(_i, content) {
        n += 1;
        if (n === 1) throw new Error("503");
        return allCorrect(
          JSON.parse(content).exercises.flatMap((e) =>
            e.items.map((i) => i.id),
          ),
        );
      },
    };
    const { grader: g } = grader(model);
    const out = await g.grade(items);
    assert.equal(out.get(hsItemIdentity(items[0])).verdict.correct, true);
  });
});

describe("batches, dedupe and the cache", () => {
  it(`sends at most ${BATCH_SIZE} items per call, grouped by exercise`, async () => {
    const model = fakeModel(allCorrect);
    const { grader: g } = grader(model);
    const many = Array.from({ length: 30 }, (_, i) => line(`q${i}`, `a${i}`));
    await g.grade(many);
    assert.deepEqual(
      model.calls.map((c) => c.content.exercises[0].items.length),
      [BATCH_SIZE, 30 - BATCH_SIZE],
    );
    assert.equal(model.calls[0].instruction, "HS-PROMPT");
    assert.equal(model.calls[0].model, "m");
  });

  it("grades the same answer to the same question once", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g } = grader(model);
    const a = line("q", "same");
    const b = { ...line("q", "same") };
    await g.grade([a, b, line("q", "other")]);
    assert.equal(model.calls[0].content.exercises[0].items.length, 2);
  });

  it("caches verdicts in hsGradingCache (never gradingCache) and reuses them", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g, db } = grader(model);
    await g.grade([line("q", "x")]);
    assert.equal(Object.keys(db.dump(CACHE_COLLECTION)).length, 1);
    assert.equal(CACHE_COLLECTION, "hsGradingCache");
    assert.deepEqual(db.dump("gradingCache"), {});
    const again = await g.grade([line("q", "x")]);
    assert.equal(model.calls.length, 1);
    assert.equal(again.get(hsItemIdentity(line("q", "x"))).source, "cache");
    // An admin run without the cache asks the model again.
    await g.grade([line("q", "x")], { useCache: false });
    assert.equal(model.calls.length, 2);
  });

  it("sends a Wh-question's underlined part and grades each part on its own", async () => {
    const model = fakeModel(allCorrect);
    const { grader: g, db } = grader(model);
    const ask = (underlined) => ({ ...line("q", "Who?"), underlined });
    const out = await g.grade([
      ask("our grandparents"),
      ask("next Sunday"),
      line("q", "Who?"),
    ]);
    const sent = model.calls[0].content.exercises[0].items;
    assert.deepEqual(
      sent.map((i) => i.underlined),
      ["our grandparents", "next Sunday", undefined],
    );
    assert.equal(out.size, 3);
    assert.equal(Object.keys(db.dump(CACHE_COLLECTION)).length, 3);
    // Without "underlined" an item keeps the identity it always had.
    assert.equal(
      hsItemIdentity(line("q", "Who?")),
      `q\u0000${JSON.stringify("Who?")}`,
    );
  });
});

describe("lib/hs/hsAnswerKey.json", () => {
  it("covers every item of the form, no unknown or duplicate key, B3 teacher-verified", async () => {
    const {
      formItems,
      validateKey,
    } = require("../scripts/buildHsAnswerKey.js");
    const key = require("../lib/hs/hsAnswerKey.json");
    assert.deepEqual(validateKey(key, await formItems()), []);
  });
});
