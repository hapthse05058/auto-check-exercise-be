/**
 * SEC LMS → grading items, and grading results → an LMS draft. Pure functions
 * only (no network, no Firestore) so every rule below is unit-tested against
 * data shaped exactly like the LMS's own responses (tests/helpers/lmsFixtures).
 *
 * What the LMS hands us (GET .../grading/{studentId}/assignment): one entry per
 * essay assignment of the session, each a tree
 *   gradingList.questionGroupList[].{title[], questionGroup[].questionList[]}
 * where a question of type 3 (SOURCE_ONLY) is a heading row and type 2 (ESSAY)
 * an answerable one. Texts are tiptap JSON strings.
 *
 * Graded assignments (by name) and how:
 *   "BÀI TẬP VIẾT CÂU"                writing     the Basic prompt (gradeItemsCached)
 *   "BÀI TẬP SẮP XẾP TỪ THÀNH CÂU"    word_order  lib/lms/lmsExtraGrader.js
 *   "BÀI TẬP CHÍNH TẢ"                spelling    lib/lms/lmsExtraGrader.js
 * An assignment the student did not submit is left alone. Every other
 * assignment, and every question we do not grade, is never sent.
 *
 * Question classes (plan R1):
 *   supported  answered                               → AI, counts in score
 *   blank      not answered                           → skipped: not counted,
 *                                                       review left empty
 *   excluded   formula rows (HTĐ / B1: / B2:)         → untouched, not counted
 *   uncertain  no readable prompt (image, audio, …)   → untouched, not counted
 */
const crypto = require("crypto");

/** LMS question types (its own enum: MCQ, FILL, ESSAY, SOURCE_ONLY). */
const QUESTION_TYPE = Object.freeze({
  MCQ: 0,
  FILL: 1,
  ESSAY: 2,
  SOURCE_ONLY: 3,
});

/** LMS gradingStatus (PENDING, MCQ_ONLY, COMPLETED, LATE, INPROGRESS). */
const GRADING_STATUS = Object.freeze({
  PENDING: 0,
  MCQ_ONLY: 1,
  COMPLETED: 2,
  LATE: 3,
  INPROGRESS: 4,
});

const QUESTION_CLASS = Object.freeze({
  SUPPORTED: "supported",
  BLANK: "blank",
  EXCLUDED: "excluded",
  UNCERTAIN: "uncertain",
});

/** Assignment kinds the tool grades. */
const KIND = Object.freeze({
  WRITING: "writing",
  WORD_ORDER: "word_order",
  SPELLING: "spelling",
});

// Same task types as lib/gradingKey.js (and the doc parser's KIND_*).
const TASK_VI_EN = "vi_en";
const TASK_ACTIVE_PASSIVE = "active_passive";

/** Assignment name → kind. First match wins. */
const ASSIGNMENT_KINDS = [
  [KIND.WRITING, /vi[eế]t\s*c[aâ]u/iu],
  [KIND.WORD_ORDER, /s[aắ]p\s*x[eế]p/iu],
  [KIND.SPELLING, /ch[ií]nh\s*t[aả]/iu],
];

/**
 * The doc parser's ACTIVE_HEADER / PASSIVE_HEADER (lib/doc/docTableDetect.js,
 * not exported there and that file is a verbatim copy of the website's — so
 * repeated here rather than edited there).
 */
const ACTIVE_HEADER = /c[aâ]u\s*ch[uủ]\s*đ[oộ]ng/iu;
const PASSIVE_HEADER = /b[iị]\s*đ[oộ]ng/iu;

/**
 * Formula rows the student fills in ("Thành lập các thì sau theo 2 bước":
 * HTĐ → "V", HTTD / B1: / B2: → "Be+Ving"). The Basic prompt says these are
 * never sent to it (prompt line "TUYỆT ĐỐI KHÔNG chấm các dòng công thức").
 * Writing assignments only.
 */
const FORMULA_HEADING = /th[aà]nh\s*l[aậ]p/iu;
const FORMULA_STEP = /\bB\s*[12]\s*:/u;
const TENSE_ABBREVIATION =
  /^(HTĐ|HTTD|HTHT|HTHTTD|QKĐ|QKTD|QKHT|QKHTTD|TLĐ|TLTD|TLHT|TLHTTD|TLG|TLGĐ)$/iu;

/**
 * LMS group headings name the tense by its abbreviation only ("HTHTTD"). The
 * Basic prompt makes a [CHỦ ĐIỂM] that names a structure binding, but the
 * model does not read the abbreviation as one: "She has read 30 books" under
 * HTHTTD came back ✅. Spelled out with its form, the rule applies.
 */
const TENSE_NAMES = Object.freeze({
  HTĐ: "Hiện tại đơn (V / V-s/es)",
  HTTD: "Hiện tại tiếp diễn (am/is/are + V-ing)",
  HTHT: "Hiện tại hoàn thành (have/has + V3/ed)",
  HTHTTD: "Hiện tại hoàn thành tiếp diễn (have/has been + V-ing)",
  QKĐ: "Quá khứ đơn (V2/ed)",
  QKTD: "Quá khứ tiếp diễn (was/were + V-ing)",
  QKHT: "Quá khứ hoàn thành (had + V3/ed)",
  QKHTTD: "Quá khứ hoàn thành tiếp diễn (had been + V-ing)",
  TLĐ: "Tương lai đơn (will + V)",
  TLTD: "Tương lai tiếp diễn (will be + V-ing)",
  TLHT: "Tương lai hoàn thành (will have + V3/ed)",
  TLHTTD: "Tương lai hoàn thành tiếp diễn (will have been + V-ing)",
  TLG: "Tương lai gần (am/is/are going to + V)",
});

/** "HTHTTD" → "HTHTTD – Hiện tại hoàn thành tiếp diễn (…)"; others as is. */
function spellOutTense(section) {
  const text = String(section || "").trim();
  if (!TENSE_ABBREVIATION.test(text)) return text;
  const name = TENSE_NAMES[text.toUpperCase()];
  return name ? `${text} – ${name}` : text;
}

/**
 * Review the first version wrote on a question left blank (it counted those
 * as wrong). Blank questions are now skipped; this text marks an older draft
 * whose blanks must be cleared and whose score must be worked out again.
 */
const BLANK_REVIEW = "Chưa làm";

/** Score thresholds (plan R2): share of correct answers → 1..5. */
function scoreOf(correct, counted) {
  if (!(counted > 0)) return null;
  const ratio = correct / counted;
  if (ratio >= 1) return 5;
  if (ratio >= 0.8) return 4;
  if (ratio >= 0.6) return 3;
  if (ratio >= 0.4) return 2;
  return 1;
}

/**
 * Plain text of a tiptap JSON string. Paragraphs, list items and hard breaks
 * become line breaks. A string that is not JSON is returned as is (the LMS's
 * own editor does the same), and "" stays "". With `markBold`, bold runs come
 * back wrapped in "**" — the inverse of reviewToTiptap.
 */
function tiptapToText(source, { markBold = false } = {}) {
  if (source === null || source === undefined || source === "") return "";
  let node;
  try {
    node = typeof source === "string" ? JSON.parse(source) : source;
  } catch {
    return String(source).trim();
  }
  if (!node || typeof node !== "object") return String(source).trim();
  const lines = [];
  let current = "";
  const BLOCKS = new Set(["paragraph", "heading", "listItem", "tableRow"]);
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text") {
      const bold = markBold && (n.marks || []).some((m) => m?.type === "bold");
      current += bold && n.text?.trim() ? `**${n.text}**` : n.text || "";
    } else if (n.type === "hardBreak") {
      lines.push(current);
      current = "";
    }
    for (const child of n.content || []) walk(child);
    if (BLOCKS.has(n.type)) {
      lines.push(current);
      current = "";
    }
  };
  walk(node);
  if (current) lines.push(current);
  return lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Text of an LMS content array ([{type, source}]); non-text parts flagged. */
function contentText(content) {
  const parts = Array.isArray(content) ? content : [];
  const text = parts
    .filter((c) => c && (c.type === 0 || c.type === undefined))
    .map((c) => tiptapToText(c.source))
    .filter(Boolean)
    .join("\n");
  const hasMedia = parts.some((c) => c && c.type !== 0 && c.type !== undefined);
  return { text, hasMedia };
}

/** The student's answer: every selected answer's text, joined by lines. */
function answerText(question) {
  const selected = Array.isArray(question?.selectedAnswer)
    ? question.selectedAnswer
    : [];
  return selected
    .map((s) => contentText(s?.content).text)
    .filter(Boolean)
    .join("\n");
}

const firstLine = (text) =>
  String(text || "")
    .split("\n")[0]
    .trim();

/** Every non-heading question, in order, with its group title and heading. */
function walkQuestions(assignment) {
  const out = [];
  const groups = assignment?.gradingList?.questionGroupList || [];
  for (const group of groups) {
    const groupTitle = contentText(group?.title).text;
    // A heading row applies to the questions after it within this group.
    let heading = "";
    for (const questionGroup of group?.questionGroup || []) {
      for (const question of questionGroup?.questionList || []) {
        if (question?.type === QUESTION_TYPE.SOURCE_ONLY) {
          heading = contentText(question.content).text;
          continue;
        }
        out.push({ question, groupTitle, heading });
      }
    }
  }
  return out;
}

/** Key of one question across the whole session (plan R3). */
const questionKey = (assignmentId, questionId) =>
  `${assignmentId}:${questionId}`;

/** The kind of an assignment (by name), or null when the tool skips it. */
function assignmentKind(assignment) {
  const name = String(assignment?.name || "");
  for (const [kind, pattern] of ASSIGNMENT_KINDS) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

const isTargetAssignment = (assignment) => assignmentKind(assignment) !== null;
const isWritingAssignment = (assignment) =>
  assignmentKind(assignment) === KIND.WRITING;

/** Classifies one ESSAY question (plan R1). */
function classifyQuestion(
  { question, groupTitle, heading },
  kind = KIND.WRITING,
) {
  const { text, hasMedia } = contentText(question?.content);
  if (kind === KIND.WRITING) {
    const context = `${groupTitle}\n${heading}`;
    if (
      FORMULA_HEADING.test(context) ||
      FORMULA_STEP.test(text) ||
      TENSE_ABBREVIATION.test(firstLine(text))
    ) {
      return { cls: QUESTION_CLASS.EXCLUDED, reason: "formula" };
    }
  }
  if (!text) {
    return {
      cls: QUESTION_CLASS.UNCERTAIN,
      reason: hasMedia ? "mediaOnly" : "noPrompt",
    };
  }
  if (!answerText(question)) return { cls: QUESTION_CLASS.BLANK };
  return { cls: QUESTION_CLASS.SUPPORTED };
}

function taskTypeOf(groupTitle, heading) {
  const context = `${groupTitle}\n${heading}`;
  return ACTIVE_HEADER.test(context) && PASSIVE_HEADER.test(context)
    ? TASK_ACTIVE_PASSIVE
    : TASK_VI_EN;
}

/** Assignments to look at: graded kinds, and (if given) submitted ones. */
function targetAssignments(grading, submittedIds = null) {
  return (Array.isArray(grading) ? grading : []).filter(
    (a) =>
      isTargetAssignment(a) &&
      (!submittedIds || submittedIds.has(String(a.assignmentId))),
  );
}

/**
 * Reads a student's session into gradable items.
 *
 * @param opts.submittedIds  Set of assignment ids (strings) the student
 *   submitted; others are left out. Omitted: every graded kind.
 * @returns {{
 *   targets: Array<{assignmentId, assignmentLogId, name, kind, gradingStatus}>,
 *   questions: Array<{key, assignmentId, assignmentName, kind, questionId,
 *     serialNumber, cls, reason?, question, answer, section, context,
 *     taskType, existingReview, existingCorrect}>,
 *   counts: {supported, blank, excluded, uncertain}
 * }}
 */
function itemsFromGrading(grading, { submittedIds = null } = {}) {
  const targets = [];
  const questions = [];
  const counts = { supported: 0, blank: 0, excluded: 0, uncertain: 0 };
  for (const assignment of targetAssignments(grading, submittedIds)) {
    const kind = assignmentKind(assignment);
    targets.push({
      assignmentId: assignment.assignmentId,
      assignmentLogId: assignment.assignmentLogId ?? null,
      name: assignment.name,
      kind,
      gradingStatus: assignment.gradingStatus ?? null,
    });
    for (const entry of walkQuestions(assignment)) {
      const { question, groupTitle, heading } = entry;
      if (question?.type !== QUESTION_TYPE.ESSAY) continue;
      const { cls, reason } = classifyQuestion(entry, kind);
      counts[cls] += 1;
      const rawSection = firstLine(heading) || firstLine(groupTitle);
      const section =
        kind === KIND.WRITING ? spellOutTense(rawSection) : rawSection;
      questions.push({
        key: questionKey(assignment.assignmentId, question.id),
        assignmentId: assignment.assignmentId,
        assignmentName: assignment.name,
        kind,
        questionId: question.id,
        serialNumber: question.serialNumber ?? null,
        cls,
        ...(reason ? { reason } : {}),
        question: contentText(question.content).text,
        answer: answerText(question),
        section: section.slice(0, 200),
        // The whole rule text of the group (word order / spelling prompts).
        context: [groupTitle, heading].filter(Boolean).join("\n").slice(0, 600),
        taskType: taskTypeOf(groupTitle, heading),
        existingReview: tiptapToText(question.review),
        existingReviewMarked: tiptapToText(question.review, { markBold: true }),
        existingCorrect: question.selectedAnswer?.[0]?.isCorrect === 1,
      });
    }
  }
  return { targets, questions, counts };
}

/**
 * Questions the tool writes to: supported (graded) and blank (kept empty, so
 * an older "Chưa làm" is cleared; never counted).
 */
const isWritten = (q) =>
  q.cls === QUESTION_CLASS.SUPPORTED || q.cls === QUESTION_CLASS.BLANK;

/**
 * A tiptap document for a review: one paragraph per line, "**…**" in bold
 * (the same markers the doc writer turns bold).
 */
function reviewToTiptap(text) {
  const paragraphs = String(text ?? "")
    .split("\n")
    .map((line) => {
      const content = [];
      const bold = /\*\*(.+?)\*\*/g;
      let cursor = 0;
      let match;
      while ((match = bold.exec(line)) !== null) {
        if (match.index > cursor) {
          content.push({ type: "text", text: line.slice(cursor, match.index) });
        }
        content.push({
          type: "text",
          marks: [{ type: "bold" }],
          text: match[1],
        });
        cursor = match.index + match[0].length;
      }
      if (cursor < line.length) {
        content.push({ type: "text", text: line.slice(cursor) });
      }
      return content.length
        ? { type: "paragraph", content }
        : { type: "paragraph" };
    });
  return JSON.stringify({ type: "doc", content: paragraphs });
}

/** Stable JSON: object keys sorted, so equal data always hashes the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function parseMaybeJson(source) {
  if (typeof source !== "string") return source ?? null;
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}

/**
 * Every ESSAY question of the given assignments (default: the graded kinds),
 * keyed, in a stable order.
 */
function targetQuestions(grading, assignmentIds = null) {
  const wanted = assignmentIds ? new Set(assignmentIds.map(String)) : null;
  const out = [];
  for (const assignment of Array.isArray(grading) ? grading : []) {
    if (
      wanted
        ? !wanted.has(String(assignment.assignmentId))
        : !isTargetAssignment(assignment)
    ) {
      continue;
    }
    for (const { question } of walkQuestions(assignment)) {
      if (question?.type !== QUESTION_TYPE.ESSAY) continue;
      out.push({
        key: questionKey(assignment.assignmentId, question.id),
        question,
      });
    }
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Fingerprint of what the student submitted for the given assignments (plan
 * R6; default: the graded kinds). The tiptap JSON is canonicalised (key
 * order) but its text is kept verbatim: any real edit changes the hash.
 * For one writing assignment this is exactly the hash of the first version,
 * so drafts saved by it are still recognised.
 */
function hashAnswers(grading, assignmentIds = null) {
  return sha256(
    canonical(
      targetQuestions(grading, assignmentIds).map(({ key, question }) => [
        key,
        (question.selectedAnswer || []).map((s) =>
          (s?.content || []).map((c) => parseMaybeJson(c?.source)),
        ),
      ]),
    ),
  );
}

/**
 * Fingerprint of the reviews on the questions `keys`. Compared by TEXT, not
 * by JSON, so a harmless re-serialisation of our own draft by the LMS still
 * matches.
 */
function hashReviews(grading, keys) {
  const wanted = new Set(keys || []);
  const assignmentIds = [
    ...new Set([...wanted].map((k) => String(k).split(":")[0])),
  ];
  return sha256(
    canonical(
      targetQuestions(grading, assignmentIds)
        .filter(({ key }) => wanted.has(key))
        .map(({ key, question }) => [
          key,
          tiptapToText(question.review),
          question.selectedAnswer?.[0]?.isCorrect === 1 ? 1 : 0,
        ]),
    ),
  );
}

/** "YYYY-MM-DD HH:mm:ss" in Vietnam time — what the LMS's own UI sends. */
function lmsTimestamp(ms) {
  const d = new Date(ms + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/** An LMS date ("2026-11-12T21:44:50.88" or "2026-11-12 21:44:50") → text. */
function lmsDeadlineText(value) {
  if (!value) return null;
  return String(value).replace("T", " ").slice(0, 19);
}

/**
 * The verdicts of one student: per written question its review text and
 * correctness, plus the overall comment and score (plan R2), across every
 * graded assignment.
 *
 * @param questions     itemsFromGrading(...).questions (to write)
 * @param feedbackByKey Map<questionKey, feedback text> for supported ones
 * @param lib           { isCorrectFeedback, generateOverallFeedback } (lib/doc)
 */
function verdictsOf(questions, feedbackByKey, lib) {
  const verdicts = new Map();
  let correct = 0;
  let counted = 0;
  const forOverall = [];
  for (const q of questions) {
    if (!isWritten(q)) continue;
    if (q.cls === QUESTION_CLASS.BLANK) {
      // Skipped: left as an unmarked question, outside the score.
      verdicts.set(q.key, { review: "", isCorrect: false, blank: true });
      continue;
    }
    const feedback = feedbackByKey.get(q.key);
    if (feedback === undefined || feedback === null || feedback === "") {
      return { error: "missingFeedback", key: q.key };
    }
    const ok = lib.isCorrectFeedback(feedback);
    verdicts.set(q.key, { review: feedback, isCorrect: ok });
    counted += 1;
    if (ok) correct += 1;
    forOverall.push({ aiFeedback: feedback });
  }
  const score = scoreOf(correct, counted);
  return {
    verdicts,
    correct,
    counted,
    score,
    overall: counted ? lib.generateOverallFeedback(forOverall).trim() : "",
  };
}

/**
 * The PUT body for "Lưu nháp".
 *
 * Only the assignments in `result.assignmentIds` (default: every graded kind
 * present) are sent, each with the shared score and overall comment — the
 * LMS's own Lưu nháp sends one score/comment for the session. Questions
 * without a verdict are echoed with the values the LMS gave.
 *
 * @param opts.onlyTargets   false also sends the other assignments, echoed
 * @param opts.shareOverall  give those other assignments the shared
 *                           score/review too (the LMS UI does)
 * @param opts.now           ms
 */
function buildDraftPayload(grading, result, opts = {}) {
  const { onlyTargets = true, shareOverall = true, now = Date.now() } = opts;
  const nowText = lmsTimestamp(now);
  const overallReview = result.overall ? reviewToTiptap(result.overall) : "";
  const sendIds = result.assignmentIds
    ? new Set(result.assignmentIds.map(String))
    : new Set(targetAssignments(grading).map((a) => String(a.assignmentId)));
  const body = [];
  for (const assignment of Array.isArray(grading) ? grading : []) {
    const target = sendIds.has(String(assignment.assignmentId));
    if (onlyTargets && !target) continue;
    const deadline = lmsDeadlineText(assignment.checkDeadline);
    const late = Boolean(deadline && nowText > deadline);
    const questionReviews = [];
    for (const group of assignment?.gradingList?.questionGroupList || []) {
      for (const questionGroup of group?.questionGroup || []) {
        for (const question of questionGroup?.questionList || []) {
          if (question?.type === QUESTION_TYPE.SOURCE_ONLY) continue;
          const key = questionKey(assignment.assignmentId, question.id);
          const verdict = target ? result.verdicts.get(key) : undefined;
          if (verdict?.blank) {
            // Left blank by the student: the empty, unmarked state.
            questionReviews.push({
              questionId: question.id,
              review: "",
              gradingLateFlag: null,
              gradedAt: null,
              isCorrect: 0,
            });
          } else if (verdict) {
            questionReviews.push({
              questionId: question.id,
              review: reviewToTiptap(verdict.review),
              gradingLateFlag: late,
              gradedAt: nowText,
              isCorrect: verdict.isCorrect ? 1 : 0,
            });
          } else {
            // Not ours: every field as the LMS gave it (only the date is put
            // in the LMS's own "YYYY-MM-DD HH:mm:ss" form).
            questionReviews.push({
              questionId: question.id,
              review: question.review ?? "",
              gradingLateFlag: question.gradingLateFlag ?? null,
              gradedAt: question.gradedAt
                ? lmsDeadlineText(question.gradedAt)
                : null,
              isCorrect: question.selectedAnswer?.[0]?.isCorrect === 1 ? 1 : 0,
            });
          }
        }
      }
    }
    const useOverall = target || shareOverall;
    body.push({
      assignmentId: assignment.assignmentId,
      // Echoed verbatim (null included) when not ours to set.
      score: useOverall ? result.score : (assignment.score ?? 0),
      review: useOverall ? overallReview : (assignment.review ?? null),
      questionReviews,
    });
  }
  return body;
}

/**
 * Hash of the reviews a draft would leave on the written questions — compared
 * against hashReviews(reread, keys) to recognise our own draft (plan R6).
 */
function hashDraft(grading, result) {
  const keys = [...result.verdicts.keys()];
  const wanted = new Set(keys);
  const assignmentIds = [...new Set(keys.map((k) => String(k).split(":")[0]))];
  return sha256(
    canonical(
      targetQuestions(grading, assignmentIds)
        .filter(({ key }) => wanted.has(key))
        .map(({ key }) => {
          const v = result.verdicts.get(key);
          return [
            key,
            tiptapToText(reviewToTiptap(v.review)),
            v.isCorrect ? 1 : 0,
          ];
        }),
    ),
  );
}

module.exports = {
  BLANK_REVIEW,
  spellOutTense,
  GRADING_STATUS,
  KIND,
  QUESTION_CLASS,
  QUESTION_TYPE,
  TASK_ACTIVE_PASSIVE,
  TASK_VI_EN,
  answerText,
  assignmentKind,
  buildDraftPayload,
  canonical,
  classifyQuestion,
  hashAnswers,
  hashDraft,
  hashReviews,
  isTargetAssignment,
  isWritingAssignment,
  isWritten,
  itemsFromGrading,
  lmsTimestamp,
  questionKey,
  reviewToTiptap,
  scoreOf,
  tiptapToText,
  verdictsOf,
};
