/**
 * Grading the HS course (course gradingProfile "hs"): pupils of primary and
 * lower-secondary school, 24 lessons + 2 reviews, one fixed Google Doc form.
 *
 * Fully separate from Basic and IELTS: its own system prompt
 * (prompt_hs.txt), its own model settings (HS_AI_*), its own cache collection
 * (hsGradingCache — never gradingCache) and its own answer key
 * (lib/hs/hsAnswerKey.json). The items come from lib/doc/hsDoc.js
 * (collectHsItems); what this module returns is a verdict per item —
 * {correct, corrected?, explanation?, expected?} — which hsDoc's
 * formatHsFeedback turns into the text written into the doc.
 *
 * Order of decisions for one item:
 *   1. a blank ("blank", "passage", "listening") whose answer is one of the
 *      APPROVED answer-key answers is correct — no model call at all;
 *   2. a listening blank (Buổi 03, graded from audio the model cannot hear)
 *      is otherwise wrong against the key — or skipped with hsKeyMissing when
 *      it has no approved key; it is never sent to the model;
 *   3. the cache (hsGradingCache);
 *   4. the model, in batches; the key's answers go along as a reference.
 *
 * A batch answer is used only when it is COMPLETE and VALID: every item sent
 * comes back exactly once, with a boolean verdict and a correction when
 * wrong. Otherwise the whole answer is dropped and the batch asked again, once;
 * results of two attempts are never mixed. Items of a batch that failed twice
 * come back as null (not graded — never written).
 */
const crypto = require("node:crypto");

const CACHE_COLLECTION = "hsGradingCache";
const BATCH_SIZE = 24;
const MAX_ATTEMPTS = 2;

/** Kinds whose answer can be checked against the key without the model. */
const KEYED_KINDS = new Set(["blank", "passage", "listening"]);
const APPROVED_SOURCES = new Set(["teacher_verified", "ai_draft_approved"]);

const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");

/** Answer text for comparison: case, quotes, spaces and end punctuation aside. */
function normalizeAnswer(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/_+/g, " ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, "")
    .trim();
}

/** The student's answer of a keyed item as one string: "fill1 | fill2". */
function keyedAnswer(item) {
  if (item.kind === "blank") return (item.answer?.fills || []).join(" | ");
  return typeof item.answer === "string" ? item.answer : "";
}

/** Two items are the same question with the same answer: graded once. */
function hsItemIdentity(item) {
  const base = `${item.key}\u0000${JSON.stringify(item.answer)}`;
  // The part a Wh-question must ask about can differ between copies.
  return item.underlined ? `${base}\u0000u:${item.underlined}` : base;
}

const approved = (entry) =>
  Boolean(entry && APPROVED_SOURCES.has(entry.source) && entry.answers?.length);

/**
 * The decision the key alone can make: {verdict} or {skip: code}, or null
 * when the model must decide.
 */
function decideFromKey(item, entry) {
  if (!KEYED_KINDS.has(item.kind)) return null;
  if (item.kind === "listening" && !approved(entry)) {
    return { skip: "hsKeyMissing" };
  }
  if (!approved(entry)) return null;
  const answer = normalizeAnswer(keyedAnswer(item));
  if (entry.answers.some((a) => normalizeAnswer(a) === answer)) {
    return { verdict: { correct: true } };
  }
  if (item.kind === "listening") {
    return { verdict: { correct: false, expected: entry.answers[0] } };
  }
  return null;
}

function cacheKey({ promptVersion, model, item, entry }) {
  return sha1(
    [
      "hs",
      promptVersion,
      model,
      item.kind,
      item.key,
      normalizeAnswer(JSON.stringify(item.answer)),
      sha1(JSON.stringify(entry?.answers || null)),
      // Only when present, so every other item keeps its cache key.
      ...(item.underlined ? [`u:${item.underlined}`] : []),
    ].join("|"),
  );
}

/**
 * The rearrange-the-words exercises (Buổi 05–08, 17, 18, 20): the teachers
 * want the Vietnamese meaning of the sentence written with the correction
 * (only with a correction — a right sentence gets the tick alone).
 * Not the "Sắp xếp từ vào âm" sound sorting — that is kind "sort".
 */
const REARRANGE =
  /\b(re)?arrange the (following )?words\b|\bput the words in the correct order\b/i;
const wantsTranslation = (item) =>
  item.kind === "line" && REARRANGE.test(String(item.instruction || ""));

/**
 * The lesson's number in course order: hsLesson09 → 9; the two reviews come
 * after Buổi 24. Null when the id is not an HS lesson.
 */
function lessonNumber(lessonId) {
  const lesson = /^hsLesson(\d+)$/.exec(String(lessonId || ""));
  if (lesson) return Number(lesson[1]);
  const review = /^hsReview(\d+)$/.exec(String(lessonId || ""));
  return review ? 24 + Number(review[1]) : null;
}

/** What the model sees of one item (the exercise's instruction is shared). */
function itemPayload(id, item, entry) {
  return {
    id,
    kind: item.kind,
    ...(wantsTranslation(item) ? { translate: true } : {}),
    prompt: item.prompt,
    ...(item.hint ? { hint: item.hint } : {}),
    ...(item.labels ? { labels: item.labels } : {}),
    ...(item.options ? { options: item.options } : {}),
    ...(item.slot !== undefined ? { blank: item.slot + 1 } : {}),
    ...(item.underlined ? { underlined: item.underlined } : {}),
    answer: item.answer,
    ...(entry?.answers?.length ? { key: entry.answers } : {}),
    ...(entry?.note ? { keyNote: entry.note } : {}),
  };
}

/** The user message for one batch: items grouped under their exercise. */
function buildBatchContent(batch) {
  const exercises = [];
  for (const { id, item, entry } of batch) {
    const exKey = `${item.lessonId || ""}|${item.exerciseId}`;
    let ex = exercises.find((e) => e.key === exKey);
    if (!ex) {
      const lesson = lessonNumber(item.lessonId);
      ex = {
        key: exKey,
        ...(lesson ? { lesson } : {}),
        exercise: item.exerciseId,
        instruction: String(item.instruction || "").slice(0, 600),
        items: [],
      };
      exercises.push(ex);
    }
    ex.items.push(itemPayload(id, item, entry));
  }
  return JSON.stringify(
    {
      exercises: exercises.map(({ key: _key, ...rest }) => rest),
      rule: "Return ONLY the JSON object. Every item id above must appear exactly once.",
    },
    null,
    1,
  );
}

/** First JSON object in a model answer (a ```json fence tolerated). */
function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

const text = (value) => {
  if (typeof value === "string") return value.trim();
  return value === null || value === undefined ? "" : String(value);
};

/**
 * The payload's field names are the model's words, not the pupil's: an
 * explanation that says "Prompt có “một chàng trai”" reads as "Đề bài có …".
 */
const FIELD_WORDS = [
  [/\b(the )?prompts?\b/gi, "đề bài"],
  [/\b(the )?hints?\b/gi, "gợi ý"],
];
function plainExplanation(value) {
  let out = text(value);
  for (const [re, word] of FIELD_WORDS) {
    out = out.replace(re, (m, _the, offset) =>
      offset === 0 ? word[0].toUpperCase() + word.slice(1) : word,
    );
  }
  return out;
}

/**
 * The verdicts of a batch answer, keyed by id — or null when the answer is
 * not complete and valid (then NONE of it is used). A WRONG answer to an id
 * in `translate` must come with its Vietnamese "translation"; a right one is
 * not translated (the teachers translate only the sentences to fix).
 */
function parseBatchAnswer(raw, ids, translate = new Set()) {
  const parsed = extractJson(raw);
  const list = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!list || list.length !== ids.length) return null;
  const want = new Set(ids);
  const out = new Map();
  for (const entry of list) {
    const id = text(entry?.id);
    if (!want.has(id) || out.has(id)) return null;
    if (typeof entry.correct !== "boolean") return null;
    const verdict = { correct: entry.correct };
    if (!entry.correct) {
      const corrected = text(entry.corrected);
      const expected = text(entry.expected);
      if (!corrected && !expected) return null;
      if (corrected) verdict.corrected = corrected;
      if (expected) verdict.expected = expected;
      const explanation = plainExplanation(entry.explanation);
      if (explanation) verdict.explanation = explanation;
    }
    if (!entry.correct && translate.has(id)) {
      const translation = text(entry.translation);
      if (!translation) return null;
      verdict.translation = translation;
    }
    out.set(id, verdict);
  }
  return out.size === ids.length ? out : null;
}

/**
 * @param deps.db            Firestore (hsGradingCache)
 * @param deps.callModel     (instruction, content, model) => Promise<string>
 * @param deps.readPrompt    () => string — prompt_hs.txt
 * @param deps.model         model id
 * @param deps.promptVersion HS_PROMPT_VERSION (part of every cache key)
 * @param deps.answerKey     {entries: {[itemKey]: {answers, source, note?}}}
 * @param deps.now           () => ms
 */
function createHsGrader({
  db,
  callModel,
  readPrompt,
  model,
  promptVersion,
  answerKey = { entries: {} },
  now = () => Date.now(),
  // eslint-disable-next-line no-console
  log = (...args) => console.log("[HS]", ...args),
}) {
  const cache = () => db.collection(CACHE_COLLECTION);
  const entryOf = (item) => answerKey?.entries?.[item.key] || null;

  async function askBatch(batch, requestId) {
    const instruction = readPrompt();
    const content = buildBatchContent(batch);
    const ids = batch.map((b) => b.id);
    const translate = new Set(
      batch.filter((b) => wantsTranslation(b.item)).map((b) => b.id),
    );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let raw;
      try {
        raw = await callModel(instruction, content, model);
      } catch (err) {
        log(`${requestId || "-"} batch attempt ${attempt}: ${err.message}`);
        continue;
      }
      const verdicts = parseBatchAnswer(raw, ids, translate);
      if (verdicts) return verdicts;
      log(`${requestId || "-"} batch attempt ${attempt}: invalid answer`);
    }
    return null;
  }

  /**
   * Grades `items` (collectHsItems items, each with `lessonId`).
   *
   * @returns {Promise<Map<string, {verdict: ?object, warning?: string,
   *   source: "key"|"cache"|"model"|"none"}>>} by hsItemIdentity
   */
  async function grade(items, { useCache = true, requestId = null } = {}) {
    const out = new Map();
    const toAsk = [];
    const unique = new Map();
    for (const item of items) unique.set(hsItemIdentity(item), item);

    for (const [identity, item] of unique) {
      const entry = entryOf(item);
      const decided = decideFromKey(item, entry);
      if (decided?.verdict) {
        out.set(identity, { verdict: decided.verdict, source: "key" });
        continue;
      }
      if (decided?.skip) {
        out.set(identity, {
          verdict: null,
          warning: decided.skip,
          source: "none",
        });
        continue;
      }
      const key = cacheKey({ promptVersion, model, item, entry });
      if (useCache) {
        const snap = await cache().doc(key).get();
        if (snap.exists && snap.data()?.verdict) {
          out.set(identity, { verdict: snap.data().verdict, source: "cache" });
          cache()
            .doc(key)
            .update({
              hitCount: (snap.data().hitCount || 0) + 1,
              lastHitAt: now(),
            })
            .catch(() => {});
          continue;
        }
      }
      toAsk.push({ identity, item, entry, key });
    }

    for (let i = 0; i < toAsk.length; i += BATCH_SIZE) {
      const batch = toAsk
        .slice(i, i + BATCH_SIZE)
        .map((b, n) => ({ ...b, id: String(n + 1) }));
      const verdicts = await askBatch(batch, requestId);
      for (const b of batch) {
        const verdict = verdicts?.get(b.id) || null;
        if (!verdict) {
          out.set(b.identity, {
            verdict: null,
            warning: "hsAiInvalid",
            source: "none",
          });
          continue;
        }
        out.set(b.identity, { verdict, source: "model" });
        await cache()
          .doc(b.key)
          .set({
            itemKey: b.item.key,
            kind: b.item.kind,
            answer: JSON.stringify(b.item.answer),
            verdict,
            model,
            promptVersion,
            hitCount: 0,
            createdAt: now(),
          });
      }
    }
    return out;
  }

  return { grade };
}

module.exports = {
  APPROVED_SOURCES,
  BATCH_SIZE,
  CACHE_COLLECTION,
  KEYED_KINDS,
  MAX_ATTEMPTS,
  buildBatchContent,
  cacheKey,
  createHsGrader,
  decideFromKey,
  hsItemIdentity,
  lessonNumber,
  normalizeAnswer,
  parseBatchAnswer,
  wantsTranslation,
};
