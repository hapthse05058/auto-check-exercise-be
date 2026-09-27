const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  TASK_ACTIVE_PASSIVE,
  TASK_PARAGRAPH,
  TASK_VI_EN,
  cleanContent,
  gradingCacheKey,
  normalizeForKey,
  normalizeTaskType,
  planCacheCleanup,
} = require("../lib/gradingKey.js");

/**
 * The key exactly as it was computed before taskType existed. Kept written out
 * here on purpose: the whole point is that adding the new field did NOT move
 * the old keys, and a test that recomputes with the new code proves nothing.
 */
function legacyKey(promptVersion, model, question, answer) {
  const raw = `${promptVersion}|${model}|${normalizeForKey(question)}|${normalizeForKey(answer)}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

test("a vi_en key on clean text is byte-identical to the legacy key", () => {
  // Chữ đã sạch ⇒ bản ghi cũ giữ nguyên id, không phải chấm lại.
  const args = ["v1", "deepseek-chat", "Tôi học tiếng Anh", "I study"];
  const before = legacyKey(...args);
  // Bỏ trống, truyền rõ "vi_en", hay truyền rác — cả ba phải ra cùng một khoá,
  // nếu không toàn bộ cache hiện có thành cache miss và phải chấm lại có phí.
  assert.equal(gradingCacheKey(...args), before);
  assert.equal(gradingCacheKey(...args, TASK_VI_EN), before);
  assert.equal(gradingCacheKey(...args, undefined), before);
  assert.equal(gradingCacheKey(...args, "loại lạ"), before);
});

test("active_passive gets its own key for the same question and answer", () => {
  const args = ["v1", "deepseek-chat", "1. The teacher checks it.", "→ x"];
  assert.notEqual(
    gradingCacheKey(...args, TASK_ACTIVE_PASSIVE),
    gradingCacheKey(...args, TASK_VI_EN),
  );
});

test("paragraph gets its own key, apart from vi_en and active_passive", () => {
  const args = ["v1", "deepseek-chat", "Chủ đề: Hobbies", "My name are Tom."];
  const paragraph = gradingCacheKey(...args, TASK_PARAGRAPH);
  assert.notEqual(paragraph, gradingCacheKey(...args, TASK_VI_EN));
  assert.notEqual(paragraph, gradingCacheKey(...args, TASK_ACTIVE_PASSIVE));
  assert.equal(normalizeTaskType(TASK_PARAGRAPH), TASK_PARAGRAPH);
});

test("normalizeTaskType defaults anything unknown to vi_en", () => {
  assert.equal(normalizeTaskType(undefined), TASK_VI_EN);
  assert.equal(normalizeTaskType(null), TASK_VI_EN);
  assert.equal(normalizeTaskType("nonsense"), TASK_VI_EN);
  assert.equal(normalizeTaskType(TASK_VI_EN), TASK_VI_EN);
  assert.equal(normalizeTaskType(TASK_ACTIVE_PASSIVE), TASK_ACTIVE_PASSIVE);
});

test("the key still ignores whitespace differences", () => {
  assert.equal(
    gradingCacheKey("v1", "m", "  Tôi   học  ", "→ I study", TASK_VI_EN),
    gradingCacheKey("v1", "m", "Tôi học", "→ I study", TASK_VI_EN),
  );
});

test("cleanContent strips prefixes: index, arrows, answer labels, junk", () => {
  assert.equal(cleanContent("1. Tôi học tiếng Anh."), "Tôi học tiếng Anh");
  assert.equal(cleanContent("  12) Tôi học."), "Tôi học");
  for (const raw of [
    "→ I study. ",
    "-> I study",
    "–>I study…",
    "=> I study.",
    "Trả lời: I study.",
    "Ans: I study",
    "* I study ;",
    "(I study)",
    '"I study."',
  ]) {
    assert.equal(cleanContent(raw), "I study", raw);
  }
});

test("cleanContent keeps only ? and ! at the end", () => {
  assert.equal(cleanContent("→ Where are you?"), "Where are you?");
  assert.equal(cleanContent("Where are you?)"), "Where are you?");
  assert.equal(cleanContent("Stop!."), "Stop!");
  assert.equal(cleanContent("I study.)"), "I study");
  assert.equal(cleanContent("I study.)"), cleanContent("I study."));
});

test("cleanContent keeps a closing bracket/quote that closes content", () => {
  assert.equal(
    cleanContent("12. Tôi thích đọc sách. (Sách/trà nói chung)"),
    "Tôi thích đọc sách. (Sách/trà nói chung)",
  );
  assert.equal(cleanContent('→ He said "hi".'), 'He said "hi"');
  assert.equal(cleanContent("→ It's mine (I think)."), "It's mine (I think)");
  assert.equal(cleanContent("→ I don't (know)))."), "I don't (know)");
  assert.equal(cleanContent("I study.)"), "I study");
  for (const raw of ["(a)", 'x "y".', "a (b).)"]) {
    assert.equal(cleanContent(cleanContent(raw)), cleanContent(raw), raw);
  }
});

test("cleanContent keeps numbers that are content, not an index", () => {
  assert.equal(cleanContent("→ 2 students came."), "2 students came");
  assert.equal(
    cleanContent("3.5 million people live here."),
    "3.5 million people live here",
  );
  assert.equal(cleanContent("1. 20 người đến."), "20 người đến");
});

test("cleanContent keeps a trailing Vietnamese letter in NFD form", () => {
  const nfd = "Tôi học tiếng Việt.".normalize("NFD");
  assert.equal(cleanContent(nfd), "Tôi học tiếng Việt".normalize("NFD"));
});

test("cleanContent cleans each line and drops empty ones", () => {
  assert.equal(
    cleanContent("1. Câu đơn: Tôi học.\n\nCâu phức: Tôi học khi rảnh.\n→ "),
    "Câu đơn: Tôi học\nCâu phức: Tôi học khi rảnh",
  );
  assert.equal(cleanContent("→ I   study\v-> hard ."), "I study\nhard");
});

test("cleanContent is idempotent and safe on empty input", () => {
  for (const raw of ["1. Tôi học.", "→ Where?)", "  ", "→", "I study.)"]) {
    assert.equal(cleanContent(cleanContent(raw)), cleanContent(raw));
  }
  assert.equal(cleanContent(null), "");
  assert.equal(cleanContent(undefined), "");
  assert.equal(cleanContent("→ ."), "");
});

test("the key ignores prefix/suffix noise but not the content", () => {
  const key = (q, a) => gradingCacheKey("v1", "m", q, a, TASK_VI_EN);
  assert.equal(key("1. Tôi học.", "→ I study."), key("Tôi học", "I study"));
  assert.equal(key("3) Tôi học", "-> I study.)"), key("Tôi học", "I study"));
  assert.notEqual(key("Tôi học", "I study"), key("Tôi đọc", "I study"));
  assert.notEqual(key("Tôi học", "I study"), key("Tôi học", "I studied"));
  assert.notEqual(key("Q", "Where are you?"), key("Q", "Where are you"));
});

const ts = (ms) => ({ toMillis: () => ms });
const rec = (question, answer, extra = {}) => ({
  promptVersion: "v1",
  model: "m",
  question,
  answer,
  feedback: `fb:${question}|${answer}`,
  hitCount: 0,
  ...extra,
});

test("planCacheCleanup merges duplicates: top hitCount wins, hits summed", () => {
  const cleanId = gradingCacheKey("v1", "m", "Tôi học", "I study");
  const docs = [
    { id: "a", data: rec("1. Tôi học.", "→ I study.", { hitCount: 2 }) },
    { id: "b", data: rec("2. Tôi học", "-> I study", { hitCount: 5 }) },
    { id: cleanId, data: rec("Tôi học", "I study", { hitCount: 1 }) },
  ];
  const { writes, deletes, skipped } = planCacheCleanup(docs);
  assert.equal(skipped.length, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, cleanId);
  assert.equal(writes[0].data.hitCount, 8);
  assert.equal(writes[0].data.feedback, "fb:2. Tôi học|-> I study");
  assert.equal(writes[0].data.question, "Tôi học");
  assert.equal(writes[0].data.answer, "I study");
  assert.deepEqual(deletes.sort(), ["a", "b"]);
});

test("planCacheCleanup breaks hitCount ties by newest createdAt", () => {
  const docs = [
    { id: "old", data: rec("1. Q", "→ A.", { createdAt: ts(1) }) },
    { id: "new", data: rec("2. Q", "→ A", { createdAt: ts(9) }) },
  ];
  const { writes } = planCacheCleanup(docs);
  assert.equal(writes[0].data.feedback, "fb:2. Q|→ A");
});

test("planCacheCleanup leaves clean records alone and is idempotent", () => {
  const id = gradingCacheKey("v1", "m", "Tôi học", "I study");
  const clean = [{ id, data: rec("Tôi học", "I study", { hitCount: 3 }) }];
  assert.deepEqual(planCacheCleanup(clean), {
    writes: [],
    deletes: [],
    skipped: [],
  });

  const dirty = [{ id: "x", data: rec("1. Tôi học.", "→ I study.") }];
  const after = planCacheCleanup(dirty).writes.map(({ id: wid, data }) => ({
    id: wid,
    data,
  }));
  const second = planCacheCleanup(after);
  assert.equal(second.writes.length, 0);
  assert.equal(second.deletes.length, 0);
});

test("planCacheCleanup keeps task types apart and skips empty records", () => {
  const docs = [
    {
      id: gradingCacheKey("v1", "m", "Q", "A", TASK_ACTIVE_PASSIVE),
      data: rec("Q", "A", { taskType: TASK_ACTIVE_PASSIVE }),
    },
    { id: "v", data: rec("Q", "A.") },
    { id: "e", data: rec("1. Q", "→ .") },
  ];
  const { writes, skipped } = planCacheCleanup(docs);
  // The active_passive record is already clean; "v" moves to its clean vi_en id — never onto "t".
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].from, ["v"]);
  assert.equal(writes[0].data.taskType, TASK_VI_EN);
  assert.deepEqual(skipped, [{ id: "e", reason: "empty_after_clean" }]);
});
