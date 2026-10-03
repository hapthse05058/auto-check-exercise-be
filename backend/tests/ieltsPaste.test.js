const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { PasteError, gradePasted } = require("../lib/ieltsPaste.js");
const {
  CACHE_COLLECTION,
  IeltsError,
  createIeltsGrader,
  validateRequest,
} = require("../lib/ieltsWriting.js");
const { consumePointsForDocs } = require("../lib/teacherPoints.js");
const { PRICE_MANUAL_VND, balanceVndOf } = require("../lib/billing.js");
const {
  FakeFirestore,
  createFakeAdmin,
} = require("./helpers/fakeFirestore.js");

const admin = createFakeAdmin();

const VALID = JSON.stringify({
  task: "task2",
  corrected: "My essay text.",
  improved: "y",
  criteria: ["TR", "CC", "LR", "GRA"].map((key) => ({
    key,
    band: 6,
    comment: "ok",
  })),
  general: "g",
  advice: "a",
});

const TEACHER_A = { id: "tA", gmail: "a@x.com", name: "A" };
const TEACHER_B = { id: "tB", gmail: "b@x.com", name: "B" };

// Seeded in submissions' worth at the manual price, so the assertions below
// count submissions.
function setup({ answers = [], points = { tA: 5, tB: 5 } } = {}) {
  const db = new FakeFirestore();
  for (const [id, point] of Object.entries(points)) {
    db._apply({
      type: "set",
      path: `TeacherPoint/${id}`,
      data: { balanceVnd: point * PRICE_MANUAL_VND },
    });
  }
  let modelCalls = 0;
  const grader = createIeltsGrader({
    db,
    readPrompt: () => "P",
    model: "m",
    promptVersion: "v1",
    log: () => {},
    callModel: async () => {
      modelCalls++;
      const next = answers.length ? answers.shift() : VALID;
      if (next instanceof Error) throw next;
      return next;
    },
  });
  const deps = {
    db,
    grader,
    consumePoints: (charge) => consumePointsForDocs(db, admin, charge),
  };
  const run = (payer, overrides = {}) =>
    gradePasted(deps, {
      payer,
      email: payer.gmail,
      input: validateRequest({
        task: "task2",
        prompt: "Đề",
        essay: "My essay text.",
        ...overrides,
      }),
    });
  /** The balance, in submissions at the manual price. */
  const balance = async (id) =>
    balanceVndOf((await db.collection("TeacherPoint").doc(id).get()).data()) /
    PRICE_MANUAL_VND;
  return { db, run, balance, modelCalls: () => modelCalls };
}

describe("IELTS paste grading: points", () => {
  it("charges 800đ (the manual price) for a new submission", async () => {
    const { run, balance } = setup();
    const out = await run(TEACHER_A);
    assert.equal(out.charged, 1);
    assert.equal(out.chargedVnd, 800);
    assert.equal(out.balanceVnd, 3200, "4000đ minus 800đ");
    assert.equal(await balance("tA"), 4);
    assert.equal(out.result.overall, 6);
  });

  it("the same teacher grading the same submission again pays nothing", async () => {
    const { run, balance, modelCalls } = setup();
    await run(TEACHER_A);
    const again = await run(TEACHER_A);
    assert.equal(again.charged, 0);
    assert.equal(again.cached, true);
    assert.equal(await balance("tA"), 4);
    assert.equal(modelCalls(), 1);
  });

  it("a different submission is a new charge", async () => {
    const { run, balance } = setup();
    await run(TEACHER_A);
    await run(TEACHER_A, { essay: "My essay." });
    assert.equal(await balance("tA"), 3);
  });

  it("another teacher pays once, even when the result is cached", async () => {
    const { run, balance, modelCalls } = setup();
    await run(TEACHER_A);
    const b = await run(TEACHER_B);
    assert.equal(b.cached, true);
    assert.equal(b.charged, 1);
    assert.equal(await balance("tB"), 4);
    assert.equal(modelCalls(), 1);
  });

  it("a failed grading costs nothing and caches nothing", async () => {
    const { db, run, balance } = setup({ answers: ["bad", "bad"] });
    await assert.rejects(run(TEACHER_A), (err) => {
      assert.ok(err instanceof IeltsError);
      assert.equal(err.code, "ielts_ai_invalid");
      return true;
    });
    assert.equal(await balance("tA"), 5);
    assert.equal(Object.keys(db.dump("TeacherPointLedger")).length, 0);
    assert.equal(Object.keys(db.dump(CACHE_COLLECTION)).length, 0);
  });

  it("with no points the model is never called", async () => {
    const { run, modelCalls } = setup({ points: { tA: 0 } });
    await assert.rejects(run(TEACHER_A), (err) => {
      assert.ok(err instanceof PasteError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "insufficient_points");
      return true;
    });
    assert.equal(modelCalls(), 0);
  });

  it("with no points, a submission already paid for is still served", async () => {
    const { db, run } = setup({ points: { tA: 1 } });
    await run(TEACHER_A); // balance 800đ → 0
    assert.equal(
      (await db.collection("TeacherPoint").doc("tA").get()).data().balanceVnd,
      0,
    );
    const again = await run(TEACHER_A);
    assert.equal(again.charged, 0);
  });
});
