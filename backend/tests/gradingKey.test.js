const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  TASK_ACTIVE_PASSIVE,
  TASK_VI_EN,
  gradingCacheKey,
  normalizeForKey,
  normalizeTaskType,
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

test("a vi_en key is byte-identical to the pre-taskType key", () => {
  const args = ["v1", "deepseek-chat", "1. Tôi học tiếng Anh.", "→ I study."];
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
