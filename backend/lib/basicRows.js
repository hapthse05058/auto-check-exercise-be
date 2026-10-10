/**
 * Basic sentence grading: build the dataset sent to the model, parse its
 * Markdown table, and check every row before it is written or cached.
 *
 * Why the checks: the Basic prompt carries each lesson's reference answers
 * under their ORIGINAL question numbers ("2. Tôi sẽ cố gắng hết sức…"). Items
 * used to be renumbered 1..k per group, so item k could pick up the reference
 * answer of question k, and the row was trusted on its number alone — then
 * cached for every student with the same answer. Items now carry an id that
 * cannot collide with a question number ("Q3"), and a row is only accepted
 * when its id is known and unique, it echoes the answer that was sent, and
 * its correction shares words with that answer.
 */
const { TASK_ACTIVE_PASSIVE } = require("./gradingKey.js");

const ID_PREFIX = "Q";

/** The id of the i-th item of a group (0-based): "Q1", "Q2", … */
function itemId(index) {
  return `${ID_PREFIX}${index + 1}`;
}

/** "Q3", "q3", "Q 3" or a bare "3" → "Q3"; anything else → null. */
function normalizeId(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^q?\s*(\d{1,3})$/i);
  return match ? `${ID_PREFIX}${Number(match[1])}` : null;
}

// A number at the start of a question ("6. Tôi sẽ…") — never sent: it is the
// number the reference answers in the prompt are listed under.
const LEADING_NUMBER = /^\s*\d{1,3}\s*[.)]\s*/;

/**
 * The user message for one group: one block per item, keyed by its id. A
 * `section` (the heading row the question sits under, e.g. "Be going to:
 * Tương lai gần có dự định trước") is sent as [CHỦ ĐIỂM].
 */
function buildSentenceInput(group) {
  const blocks = group.map((item, i) => {
    const question = String(item.question ?? "").replace(LEADING_NUMBER, "");
    const lines = [`[ID]: ${itemId(i)}`];
    if (item.section) lines.push(`[CHỦ ĐIỂM]: ${item.section}`);
    // Bài chuyển chủ động → bị động có "đề bài" là câu TIẾNG ANH, không phải
    // câu tiếng Việt cần dịch. Gắn nhãn [VIETNAMESE] cho nó là nói dối model,
    // và prompt sẽ chấm như một bài dịch hỏng.
    if (item.taskType === TASK_ACTIVE_PASSIVE) {
      lines.push("[TASK]: ACTIVE_TO_PASSIVE", `[ACTIVE_SENTENCE]: ${question}`);
    } else {
      lines.push(`[VIETNAMESE]: ${question}`);
    }
    lines.push(`[STUDENT_ANSWER]: ${item.answer}`);
    return `\n${lines.join("\n")}`;
  });
  return `DATASET TO EVALUATE:\`\`\`\n${blocks.join("\n")}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table with exactly one row per item. Column 1 (STT) must be the item's [ID] exactly as given (Q1, Q2, …) and column 3 must copy its [STUDENT_ANSWER]. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;
}

/**
 * House spelling the teachers asked for, applied before anything is cached:
 * the past participle is "Pii", never "PII".
 */
function tidyFeedback(text) {
  return String(text ?? "").replace(/\bPII\b/g, "Pii");
}

/**
 * Rows of the model's Markdown table: [{id, question, answer, feedback}].
 * `id` is null when column 1 is not an item id. A "|" inside the feedback
 * splits it into extra columns, which are joined back.
 */
function parseGradedRows(aiText) {
  const rows = [];
  for (const line of String(aiText ?? "").split("\n")) {
    if (!line.includes("|") || /^\s*\|?\s*:?-{3,}/.test(line)) continue;
    const columns = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((col) => col.trim());
    if (columns.length < 4) continue;
    const id = normalizeId(columns[0]);
    if (!id) continue; // the header row, or text that is not a result row
    rows.push({
      id,
      question: columns[1],
      answer: columns[2],
      feedback: tidyFeedback(columns.slice(3).join(" | ").trim()),
    });
  }
  return rows;
}

/** Lower-case word tokens, without markup, arrows or punctuation. */
function words(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\*\*/g, "")
    .replace(/[’‘`]/g, "'")
    .split(/[^\p{L}\p{N}\p{M}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** Share of `expected`'s distinct words that also appear in `actual`. */
function coverage(expected, actual) {
  const want = new Set(expected);
  if (!want.size) return 1;
  const have = new Set(actual);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return hit / want.size;
}

/** The model's column 3 is the answer that was sent (not another item's). */
function echoMatches(sentAnswer, echoedAnswer) {
  const sent = words(sentAnswer);
  if (!sent.length) return true;
  return coverage(sent, words(echoedAnswer)) >= 0.7;
}

// Labels and verdicts inside a "Chữa bài" cell that are not the sentence.
const VERDICT_LABELS =
  /c[âa]u\s+(?:đ[ơo]n|ph[ứu]c)(?:\s+đ[úu]ng\s+l[àa])?\s*:|✅\s*đ[úu]ng|✅/giu;

/** The corrected sentence(s) of a feedback: no "(explanation)", no labels. */
function correctionText(feedback) {
  let text = String(feedback ?? "");
  // Explanations are in parentheses, possibly nested ("(happen (v) xảy ra)").
  for (let i = 0; i < 3; i++) text = text.replace(/\([^()]*\)/g, " ");
  return text.replace(VERDICT_LABELS, " ");
}

/**
 * False when a correction cannot belong to this answer: it shares (almost) no
 * words with it. Too short to judge → true.
 */
function correctionFitsAnswer(feedback, answer) {
  const fix = words(correctionText(feedback));
  const said = words(answer);
  if (fix.length < 4 || said.length < 4) return true;
  const shared = new Set(fix.filter((w) => said.includes(w))).size;
  return shared / Math.min(new Set(fix).size, new Set(said).size) >= 0.2;
}

/**
 * Lines up the parsed rows with the group. Returns `feedbacks` aligned with
 * `group` (null where no row could be trusted) and `rejected`
 * ([{index, reason}]) for the items to grade again on their own. A bad row
 * only costs its own item: the other rows of the group are kept.
 *
 * reason: "missing" | "duplicate" | "echo" | "mismatch" | "empty"
 */
function matchGradedRows(group, rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  const feedbacks = [];
  const rejected = [];
  group.forEach((item, index) => {
    const found = byId.get(itemId(index)) || [];
    let reason = null;
    if (found.length === 0) reason = "missing";
    else if (found.length > 1) reason = "duplicate";
    else if (!found[0].feedback) reason = "empty";
    else if (!echoMatches(item.answer, found[0].answer)) reason = "echo";
    else if (!correctionFitsAnswer(found[0].feedback, item.answer)) {
      reason = "mismatch";
    }
    feedbacks.push(reason ? null : found[0].feedback);
    if (reason) rejected.push({ index, reason });
  });
  return { feedbacks, rejected };
}

module.exports = {
  buildSentenceInput,
  correctionFitsAnswer,
  echoMatches,
  itemId,
  matchGradedRows,
  normalizeId,
  parseGradedRows,
  tidyFeedback,
};
