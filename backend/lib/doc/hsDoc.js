/**
 * HS course (học sinh cấp 1–2) — reading a student's lesson tab and writing
 * the AI's corrections back into it. The template of the "hs" grading profile
 * (backend lib/courses.js). A module of its own, like ieltsDoc.js: the Basic
 * detector/parser and the IELTS module are not touched, and this one is only
 * ever called for HS classes.
 *
 * Every HS doc is a copy of ONE fixed form (24 "Buổi" tabs + "Ôn tập thêm
 * 1/2"). hsTemplate.js — generated from that blank form by
 * scripts/buildHsTemplate.mjs — records, for each exercise of the TỰ LUẬN
 * section, the blank form's paragraphs and tables and which of them make up
 * each item. Reading a student's doc is then a DIFF against the form:
 *
 *   - the exercise is found by its header text (a 1×1 box or a paragraph);
 *   - its paragraphs are aligned with the form's, in order; a paragraph the
 *     student added belongs to the item before it;
 *   - an item's answer is what the student wrote INTO its slots: the form's
 *     text is split on its "____" runs (and on a trailing arrow), and the
 *     fixed pieces are found again in the student's text — whatever lies
 *     between them is the answer. Nothing is guessed: an item whose fixed
 *     text cannot be found is reported unreadable and left alone.
 *
 * An item already corrected — by a teacher (✅/❌, red or struck-through text,
 * a "Câu đúng:" line) or by this module (its named range) — is skipped, item
 * by item, so a teacher's partial grading is kept byte for byte.
 *
 * Writing: the correction goes right after the answer, the way the class's
 * teachers do it — " ✅" at the end of the line, or a soft line
 * break and "Câu đúng: …" — in red; for the two tables that have a "Chữa bài"
 * column (Exercise 1 and the Buổi 01 S/V/O table) into that cell. Every piece
 * of text the AI inserts is wrapped in a named range whose name carries a
 * hash of the text, so "Xóa feedback" removes exactly what the AI wrote and
 * nothing a teacher typed (a range whose text was edited is left alone).
 *
 * Pure — no network, no DOM. The backend copies this file verbatim into
 * auto-check-exercise-be/backend/lib/doc/ — see the header of docWriter.js.
 */
import { HS_LESSONS } from "./hsTemplate.js";

export const HS_NAMED_RANGE_PREFIX = "aiFb:hs:v1:";

/** A soft line break: stays inside the list item, so numbering never shifts. */
const LINE_BREAK = "\u000b";

/** The red the class's teachers correct in. */
const FEEDBACK_COLOR = { color: { rgbColor: { red: 1 } } };

// ---------------------------------------------------------------------------
// Text of a tab, character by character
// ---------------------------------------------------------------------------

/** Placeholder for an element with no text (image, chip): it keeps its index. */
const OBJECT_CHAR = "￼";

/**
 * Style flags of a text run, as a compact string: b(old) u(nderline)
 * s(trikethrough) h(ighlight) r(ed) c(olour, not red).
 */
export function styleFlags(style = {}) {
  let flags = "";
  if (style.bold) flags += "b";
  if (style.underline) flags += "u";
  if (style.strikethrough) flags += "s";
  const bg = style.backgroundColor?.color?.rgbColor;
  if (bg && !(bg.red === 1 && bg.green === 1 && bg.blue === 1)) flags += "h";
  const fg = style.foregroundColor?.color?.rgbColor;
  if (fg) {
    const r = fg.red || 0;
    const g = fg.green || 0;
    const b = fg.blue || 0;
    if (r >= 0.75 && g <= 0.35 && b <= 0.35) flags += "r";
    else if (r + g + b > 0.45) flags += "c";
  }
  return flags;
}

/**
 * One paragraph as parallel arrays: `text` (its final "\n" dropped), the Docs
 * index of each character and its style flags. `end` is the index of the
 * paragraph's "\n" — where text appended to the paragraph goes.
 */
export function paragraphChars(block) {
  const chars = [];
  const idx = [];
  const flags = [];
  for (const el of block.paragraph?.elements || []) {
    if (el.textRun) {
      const content = el.textRun.content || "";
      const f = styleFlags(el.textRun.textStyle);
      // Docs indexes count UTF-16 code units, like JS strings.
      for (let i = 0; i < content.length; i++) {
        chars.push(content[i]);
        idx.push(el.startIndex + i);
        flags.push(f);
      }
    } else if (el.startIndex !== undefined) {
      const span = (el.endIndex ?? el.startIndex + 1) - el.startIndex;
      for (let i = 0; i < span; i++) {
        chars.push(OBJECT_CHAR);
        idx.push(el.startIndex + i);
        flags.push("");
      }
    }
  }
  let end = block.endIndex !== undefined ? block.endIndex - 1 : null;
  if (chars.at(-1) === "\n") {
    end = idx.at(-1);
    chars.pop();
    idx.pop();
    flags.pop();
  }
  return {
    text: chars.join(""),
    idx,
    flags,
    end,
    start: block.startIndex,
    bullet: Boolean(block.paragraph?.bullet),
  };
}

/** A cell's paragraphs (nested tables flattened away). */
export function cellParagraphs(cell) {
  return (cell?.content || []).filter((b) => b.paragraph).map(paragraphChars);
}

/** Joins paragraphs into one text; paragraph breaks become "\n". */
export function joinParagraphs(paras) {
  const parts = { text: "", idx: [], flags: [] };
  paras.forEach((p, i) => {
    if (i > 0) {
      parts.text += "\n";
      parts.idx.push(paras[i - 1].end);
      parts.flags.push("");
    }
    parts.text += p.text;
    parts.idx.push(...p.idx);
    parts.flags.push(...p.flags);
  });
  return parts;
}

/** Plain text of a cell or block list, for display and matching. */
export function blocksText(content) {
  return (content || [])
    .map((b) =>
      b.paragraph
        ? paragraphChars(b).text
        : b.table
          ? b.table.tableRows
              .map((r) =>
                r.tableCells.map((c) => blocksText(c.content)).join(" | "),
              )
              .join("\n")
          : "",
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const QUOTES = {
  "’": "'",
  "‘": "'",
  "`": "'",
  "“": '"',
  "”": '"',
  "\u00A0": " ",
};

/** A character as the matcher sees it: curly quotes straightened. */
const normChar = (ch) => QUOTES[ch] ?? ch;

/** Text for comparison: NFC, straight quotes, single spaces, trimmed. */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/[’‘`“”\u00A0]/g, (ch) => QUOTES[ch])
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lower-cased normalizeText, for headers and keys. */
export const normalizeKey = (text) => normalizeText(text).toLowerCase();

/** Leading list numbering a student may have typed ("1.", "12)"). */
const LEADING_NUMBER = /^\s*\d{1,2}\s*[.)]\s*/;

/**
 * Strips underscores and collapses whitespace, keeping a map from each kept
 * character back to its position in `text`.
 */
function squeeze(text) {
  let out = "";
  const map = [];
  let space = true; // drops leading whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = normChar(text[i]);
    if (ch === "_" || /\s/.test(ch)) {
      if (!space) {
        out += " ";
        map.push(i);
        space = true;
      }
      continue;
    }
    out += ch;
    map.push(i);
    space = false;
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { out, map };
}

// ---------------------------------------------------------------------------
// Slots: the "____" runs of the form (and a trailing arrow)
// ---------------------------------------------------------------------------

/** A blank: 2+ underscores; runs split only by spaces ("______ _______") are one. */
const SLOT_RUN = /_{2,}(?:[ \t\u00A0]*_+)*/g;
const ARROW_END = /(→|->|⇒|=>)\s*[.]?\s*$/;
export const ARROW_START = /^\s*(→|->|⇒|=>)/;

/**
 * The fixed pieces of a form text, around its slots. `pieces.length` is
 * `slots + 1`; a slot at the very start or end leaves an empty piece. A text
 * ending in an arrow ("photo →") has a slot after it.
 */
export function slotPieces(formText) {
  const pieces = String(formText).split(SLOT_RUN);
  if (pieces.length === 1 && ARROW_END.test(formText)) pieces.push("");
  return pieces;
}

export const countSlots = (formText) => slotPieces(formText).length - 1;

/**
 * Finds the form's fixed pieces in the student's text, in order, and returns
 * what the student wrote in each slot — or null when a piece cannot be found
 * (the student changed the question itself; nothing is guessed then).
 *
 * @returns {?{fills: Array<{text: string, from: number, to: number}>,
 *            trailing: {text: string, from: number, to: number},
 *            fixed: Array<[number, number]>}}
 *   positions are offsets into `studentText`; `fixed` lists the ranges that
 *   are the form's own text.
 */
export function splitBySlots(formText, studentText) {
  const pieces = slotPieces(formText).map((p) => squeeze(p).out);
  const { out: s, map } = squeeze(studentText);
  const lower = s.toLowerCase();
  const find = (piece, from, last) => {
    if (!piece) return last ? s.length : from;
    let at = last ? s.lastIndexOf(piece) : s.indexOf(piece, from);
    if (at < from) at = -1;
    if (at < 0) {
      const lp = piece.toLowerCase();
      at = last ? lower.lastIndexOf(lp) : lower.indexOf(lp, from);
      if (at < from) at = -1;
    }
    return at;
  };

  // The first piece must open the text (a typed "1." aside).
  let cursor = 0;
  const numbered = LEADING_NUMBER.exec(s);
  const first = pieces[0];
  let at = find(first, 0, false);
  if (at > 0 && !(numbered && at <= numbered[0].length)) {
    // The piece appears only later: the question itself was changed.
    if (first) return null;
  }
  if (at < 0) return null;
  const fixed = [];
  if (first) fixed.push([at, at + first.length]);
  cursor = at + first.length;

  const fills = [];
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i];
    // The first occurrence after the cursor: a pupil who wrote the sentence
    // twice must not have the second copy read as the answer. Only a tiny
    // closing piece ("." / "?") is searched from the end, since the answer
    // itself may hold one ("a.m.").
    const isLast = i === pieces.length - 1;
    at = find(piece, cursor, isLast && piece.length < 3);
    if (at < 0) return null;
    fills.push({ from: cursor, to: at });
    if (piece) fixed.push([at, at + piece.length]);
    cursor = at + piece.length;
  }
  const trailing = { from: cursor, to: s.length };

  // Back to positions in the original text.
  const orig = (pos, isEnd) => {
    if (pos <= 0) return 0;
    if (pos >= map.length) return studentText.length;
    return isEnd ? map[pos - 1] + 1 : map[pos];
  };
  const range = ({ from, to }) => {
    const a = orig(from, false);
    const b = to > from ? orig(to, true) : a;
    return { from: a, to: b, text: cleanFill(studentText.slice(a, b)) };
  };
  return {
    fills: fills.map(range),
    trailing: range(trailing),
    fixed: fixed.map(([a, b]) => [orig(a, false), orig(b, true)]),
  };
}

/** A slot's text as the student meant it: no underscores, single spaces. */
export function cleanFill(text) {
  return String(text)
    .normalize("NFC")
    .replace(/_+/g, " ")
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Lessons and tabs
// ---------------------------------------------------------------------------

const lessonNumber = (title) => {
  const m = /^bu[oổ]i\s*0*(\d+)\b/u.exec(normalizeKey(title));
  return m ? Number(m[1]) : null;
};
const reviewNumber = (title) => {
  const m = /^ôn tập(?: thêm)?\s*0*(\d+)\b/u.exec(normalizeKey(title));
  return m ? Number(m[1]) : null;
};

/**
 * The template lesson for a course lesson: by its id ("hsLesson07",
 * "hsReview1") when it is one of ours, else by its name ("Buổi 07", "BUỔI 7",
 * "Ôn tập thêm 1"). Null when the lesson is not an HS lesson.
 */
export function hsLessonFor({ lessonId, lessonName } = {}) {
  const byId = HS_LESSONS.find((l) => l.id === lessonId);
  if (byId) return byId;
  const n = lessonNumber(lessonName);
  if (n !== null) return HS_LESSONS.find((l) => l.number === n) || null;
  const r = reviewNumber(lessonName);
  if (r !== null) {
    return HS_LESSONS.find((l) => l.id === `hsReview${r}`) || null;
  }
  return null;
}

function allTabs(tabs, out = []) {
  for (const tab of tabs || []) {
    out.push(tab);
    allTabs(tab.childTabs, out);
  }
  return out;
}

/**
 * The student's tab for a lesson, matched by number rather than spelling:
 * the form itself has "Buổi  09" (two spaces) next to "Buổi 10".
 */
export function findHsTab(tabs, lessonName, lessonId) {
  const lesson = hsLessonFor({ lessonId, lessonName });
  const list = allTabs(tabs).filter((t) => t?.documentTab);
  const title = (t) => t.tabProperties?.title;
  if (lesson) {
    const found = list.find((t) =>
      lesson.number !== null
        ? lessonNumber(title(t)) === lesson.number
        : `hsReview${reviewNumber(title(t))}` === lesson.id,
    );
    if (found) return found;
  }
  const exact = normalizeKey(lessonName);
  return list.find((t) => normalizeKey(title(t)) === exact) || null;
}

// ---------------------------------------------------------------------------
// Finding the exercises of a student's tab
// ---------------------------------------------------------------------------

const SECTION_START = /^(ii|iii|iv)\s*[.,]\s*tự luận/u;
const SECTION_END = /^v\s*\.\s*nghe và nói theo/u;

function blockKey(b) {
  if (b.paragraph) return normalizeKey(paragraphChars(b).text);
  const cell = b.table?.tableRows?.[0]?.tableCells?.[0];
  return normalizeKey(blocksText(cell?.content || []));
}

/**
 * A header without its "Exercise N:" / "BÀI TẬP TỰ CHỌN:" label: student
 * copies of the form do not always keep the number ("Exercise 1:Change the
 * singular nouns" where the form says "Exercise 2:").
 */
export const headerBody = (key) =>
  key.replace(/^(exercise\s*\d+|bài tập tự chọn)\s*[:.]?\s*/u, "");

/** "exercise" for an exercise header, "marker" for a bare "BÀI TẬP TỰ CHỌN". */
function headerKind(b) {
  const isBox = b.table && b.table.rows === 1 && b.table.columns === 1;
  if (!isBox && !b.paragraph) return null;
  const key = blockKey(b);
  if (/^exercise \d/.test(key)) return "exercise";
  if (/^bài tập tự chọn/u.test(key)) {
    return key.length < 25 ? "marker" : "exercise";
  }
  return null;
}

const nonEmptyParagraph = (b) =>
  Boolean(b.paragraph) &&
  paragraphChars(b)
    .text.replace(/\uFFFC/g, "")
    .trim() !== "";

/**
 * The TỰ LUẬN exercises of a student's tab, each with the blocks of its
 * region, matched to the template by header text.
 */
function locateExercises(tab, lesson) {
  const content = tab.documentTab?.body?.content || [];
  let start = content.findIndex(
    (b) => b.paragraph && SECTION_START.test(blockKey(b)),
  );
  if (start < 0) start = 0;
  let end = content.findIndex(
    (b, i) => i > start && b.paragraph && SECTION_END.test(blockKey(b)),
  );
  if (end < 0) end = content.length;

  const headers = [];
  for (let i = start; i < end; i++) {
    if (headerKind(content[i]) === "exercise") headers.push(i);
  }
  const found = new Map(); // exercise id → header block index
  const unknown = [];
  let from = 0;
  for (const at of headers) {
    const key = blockKey(content[at]);
    const n = lesson.exercises.findIndex(
      (e, k) =>
        k >= from && !found.has(e.id) && headerBody(key).startsWith(e.header),
    );
    if (n < 0) {
      unknown.push(key.slice(0, 80));
      continue;
    }
    found.set(lesson.exercises[n].id, at);
    from = n + 1;
  }

  const located = [];
  const missing = [];
  for (const ex of lesson.exercises) {
    const at = found.get(ex.id);
    if (at === undefined) {
      missing.push(ex.id);
      continue;
    }
    const next = headers.find((h) => h > at);
    let stop = next === undefined ? end : next;
    for (let i = at + 1; i < stop; i++) {
      if (headerKind(content[i]) === "marker") {
        stop = i;
        break;
      }
    }
    const blocks = content.slice(at + 1, stop);
    located.push({
      ex,
      paras: blocks.filter(nonEmptyParagraph).map(paragraphChars),
      tables: blocks.filter((b) => b.table).map((b) => b.table),
    });
  }
  return { located, unknown, missing };
}

// ---------------------------------------------------------------------------
// Aligning the student's paragraphs with the form's
// ---------------------------------------------------------------------------

/** What identifies a form paragraph: the start of its first fixed piece. */
function anchorOf(formText) {
  const piece = slotPieces(formText).find((p) => squeeze(p).out);
  if (piece === undefined) return null;
  const anchor = squeeze(piece).out.toLowerCase().replace(LEADING_NUMBER, "");
  return anchor ? anchor.slice(0, 24) : null;
}

/**
 * Whether a student paragraph is form paragraph `formText`, answered: all of
 * its fixed pieces are there, in order, the first one opening the paragraph.
 * A paragraph whose later text the student changed still matches on a long
 * enough opening (8+ characters), so one edit does not orphan the item.
 */
function isFormParagraph(text, formText, anchor) {
  if (splitBySlots(formText, text)) return true;
  if (!anchor || anchor.length < 8) return false;
  const s = squeeze(text).out.toLowerCase().replace(LEADING_NUMBER, "");
  return s.startsWith(anchor);
}

/**
 * Maps each form paragraph to the student's paragraph that still carries its
 * text, in order. Student paragraphs that match nothing are "extras" and
 * belong to the form paragraph before them.
 *
 * @returns {{match: Array<?number>, extras: Array<number[]>}}
 *   match[j] — student index of form paragraph j (null: not found);
 *   extras[j] — student paragraphs added after form paragraph j.
 */
export function alignParagraphs(formTexts, studentTexts) {
  const anchors = formTexts.map(anchorOf);
  // "⇒ ____", "-> That ____": too little text to be recognised out of order —
  // a teacher's own "⇒ …" correction line would pass for the next one.
  const weak = formTexts.map(
    (t) => squeeze(t.replace(ARROW_START, "")).out.length < 6,
  );
  const match = formTexts.map(() => null);
  const extras = formTexts.map(() => []);
  let j = 0;
  let last = -1;
  studentTexts.forEach((text, i) => {
    for (let k = j; k < Math.min(anchors.length, j + 4); k++) {
      if (k > j && weak[k]) continue;
      if (anchors[k] && isFormParagraph(text, formTexts[k], anchors[k])) {
        match[k] = i;
        j = k + 1;
        last = k;
        return;
      }
    }
    if (last >= 0) extras[last].push(i);
  });
  return { match, extras };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const TEACHER_MARK = /[✅❌✔✓☑✗✘]/u;
const TEACHER_LINE = /^\s*(câu đúng|sửa( lại)?|đáp án)\s*[:：→-]/iu;
const X_MARK = /^[xX×✗]$/u;

/**
 * Whether the text around an item carries a correction. Only `added` — the
 * offsets of what is NOT the form's own text — is looked at, so a "❌" or a
 * "Câu đúng" printed in the question never counts. A correction is:
 *   - a ✅/❌ (or ✔ ✓ ✗) anywhere in the added text;
 *   - red or struck-through added text (how teachers correct);
 *   - a LINE of added text that opens with "Câu đúng:", "Sửa:", "Đáp án:".
 * "Câu đúng" inside a sentence, a "→ Câu đúng: …" after the form's arrow, or
 * "Well-done" without a tick do not count.
 */
function hasTeacherMarks(text, flags, added = [{ from: 0, to: text.length }]) {
  for (const { from, to } of added) {
    for (let i = from; i < to; i++) {
      if (TEACHER_MARK.test(text[i])) return true;
      if (/\S/.test(text[i]) && /[rs]/.test(flags[i] || "")) return true;
    }
  }
  const inAdded = (pos) => added.some((r) => pos >= r.from && pos < r.to);
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== "\n" && text[i] !== LINE_BREAK) continue;
    const line = text.slice(start, i);
    const lead = start + (line.length - line.trimStart().length);
    if (lead < i && inAdded(lead) && TEACHER_LINE.test(line)) return true;
    start = i + 1;
  }
  return false;
}

/** hasTeacherMarks over a region read by readRegion. */
const regionMarked = ({ joined, split }) =>
  hasTeacherMarks(joined.text, joined.flags, [...split.fills, split.trailing]);

/** Index ranges of the text this module wrote (its named ranges). */
function ownRanges(tab) {
  const out = [];
  const named = tab.documentTab?.namedRanges || {};
  for (const [name, group] of Object.entries(named)) {
    if (!name.startsWith(HS_NAMED_RANGE_PREFIX)) continue;
    for (const nr of group.namedRanges || []) {
      for (const r of nr.ranges || []) out.push([r.startIndex, r.endIndex]);
    }
  }
  return out;
}

const overlaps = (ranges, from, to) =>
  ranges.some(([a, b]) => a <= to && b >= from);

/** The slice [from, to) of joined text as {text, flags}. */
const slice = (joined, from, to) => ({
  text: joined.text.slice(from, to),
  flags: joined.flags.slice(from, to),
});

/** Doc index just after offset `pos - 1` of a joined text. */
const indexAfter = (joined, pos) =>
  pos > 0 ? joined.idx[pos - 1] + 1 : (joined.idx[0] ?? null);

const spanOf = (joined) =>
  joined.idx.length ? [joined.idx[0], joined.idx.at(-1) + 1] : null;

/**
 * The student's side of a text region: what they wrote in the form's slots.
 * Null when the form's fixed text cannot be found.
 */
function readRegion(formText, paras) {
  const joined = joinParagraphs(paras);
  const split = splitBySlots(formText, joined.text);
  if (!split) return null;
  return { joined, split };
}

const nonEmpty = (text) => cleanFill(text).replace(/\uFFFC/g, "") !== "";

const cellAt = (tables, { t, r, c }) =>
  tables[t]?.tableRows?.[r]?.tableCells?.[c] || null;

const formCell = (ex, { t, r, c }) => ex.tables[t]?.cells?.[r]?.[c] || [];

function emptyParagraph(cell) {
  const first = cell.content?.[0];
  const at = first?.startIndex ?? cell.startIndex;
  return { text: "", idx: [], flags: [], end: at, start: at };
}

/** One table cell of an item, read against the form's cell. */
function readCell(ex, tables, part) {
  const cell = cellAt(tables, part);
  if (!cell) return null;
  let paras = cellParagraphs(cell).filter(
    (p, i, all) => i === 0 || nonEmpty(p.text) || i === all.length - 1,
  );
  let form = formCell(ex, part).join("\n");
  if (part.p !== undefined) {
    // One line of a cell ("photo →"): align the cell's lines first.
    const formLines = formCell(ex, part);
    const all = cellParagraphs(cell).filter((p) => nonEmpty(p.text));
    const { match, extras } = alignParagraphs(
      formLines,
      all.map((p) => p.text),
    );
    if (match[part.p] === null) return null;
    paras = [match[part.p], ...extras[part.p]].map((i) => all[i]);
    form = formLines[part.p];
  }
  if (!paras.length) paras = [emptyParagraph(cell)];
  const region = readRegion(form, paras);
  if (!region) return null;
  return { ...region, cell, paras };
}

/** The whole answer written in a region: slot fills, then any extra text. */
const answerText = (region) =>
  cleanFill(
    [...region.split.fills.map((f) => f.text), region.split.trailing.text]
      .filter(Boolean)
      .join(" "),
  );

/** The form text with every slot replaced by what the student wrote in it. */
function filledText(formText, fills) {
  const pieces = slotPieces(formText);
  let out = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    const fill = fills[i - 1]?.text || "";
    out += (fill ? ` ${fill} ` : " ___ ") + pieces[i];
  }
  return normalizeText(out);
}

function readTableItem(ex, item, tables, own) {
  const cells = item.parts.map((part) => readCell(ex, tables, part));
  if (cells.some((c) => !c)) return { unreadable: true };
  const spans = cells.map((c) => spanOf(c.joined)).filter(Boolean);
  let answer;
  let answered;
  if (ex.layout === "svo") {
    const [subject, verb, object] = cells.map(answerText);
    answer = { subject, verb, object };
    answered = [subject, verb, object].some(Boolean);
  } else if (ex.layout === "tense") {
    const xTenses = [];
    const written = [];
    cells.forEach((c, i) => {
      const text = answerText(c);
      if (X_MARK.test(text)) xTenses.push(item.labels[i]);
      else if (text) written.push({ text, tense: item.labels[i] });
    });
    answer = {
      translation: written.map((w) => w.text).join(" / "),
      chosenTense: written.map((w) => w.tense).join(" / ") || null,
      xTenses,
    };
    answered = written.length > 0 || xTenses.length > 0;
  } else if (ex.layout === "columns") {
    answer = cells.map(answerText).filter(Boolean).join(", ");
    answered = Boolean(answer);
  } else {
    answer = answerText(cells[0]);
    answered = Boolean(answer);
  }

  let graded = cells.some((c) => regionMarked(c));
  let target;
  if (item.fb) {
    const fbCell = cellAt(tables, item.fb);
    if (!fbCell) return { unreadable: true };
    const fbParas = cellParagraphs(fbCell);
    if (fbParas.some((p) => nonEmpty(p.text))) graded = true;
    target = {
      mode: "cell",
      index: fbParas[0]?.start ?? emptyParagraph(fbCell).start,
    };
    spans.push([fbCell.startIndex, fbCell.endIndex]);
  } else {
    const written = cells.filter(
      (c) => nonEmpty(c.joined.text) && !X_MARK.test(answerText(c)),
    );
    const host =
      ex.layout === "columns" || ex.layout === "tense"
        ? written.at(-1) || cells[0]
        : cells[0];
    target = { mode: "append", index: host.paras.at(-1).end };
  }
  if (spans.some(([a, b]) => overlaps(own, a, b))) graded = true;
  return { answer, answered, graded, target };
}

/** "(is/am/are)": which option(s) the student marked by formatting it. */
function readChoose(ex, item, paras, own) {
  const joined = joinParagraphs(paras);
  const form = ex.paras[item.parts[0].p];
  const formFlags = String(form.flags || "").split(",");
  const straight = (s) => s.replace(/[’‘]/g, "'");
  const formAt = form.text.indexOf(item.group);
  const at = straight(joined.text).indexOf(straight(item.group));
  if (formAt < 0) return { unreadable: true };
  if (at < 0) return readCircledChoice(item, joined, form, formAt, paras, own);

  const selected = [];
  let offset = 1; // past "("
  for (const option of item.options) {
    const start = item.group.indexOf(option, offset);
    offset = start + option.length;
    for (let k = start; k < start + option.length; k++) {
      const mine = joined.flags[at + k] || "";
      const base = formFlags[formAt + k] || "";
      if ([...mine].some((f) => "bhucr".includes(f) && !base.includes(f))) {
        selected.push(option);
        break;
      }
    }
  }
  // Or typed after the sentence: "… (it/its) is not messy. → it".
  const tailFrom = at + item.group.length;
  const formTail = normalizeText(form.text.slice(formAt + item.group.length));
  const tail = joined.text.slice(tailFrom);
  let typedFrom = tailFrom;
  if (formTail && normalizeText(tail).startsWith(formTail)) {
    // Skip the form's own rest of the sentence.
    const rest = squeeze(tail);
    const cut = rest.out.toLowerCase().indexOf(formTail.toLowerCase());
    if (cut >= 0) {
      const endPos = cut + formTail.length;
      typedFrom =
        tailFrom + (endPos >= rest.map.length ? tail.length : rest.map[endPos]);
    }
  }
  const typed = slice(joined, typedFrom, joined.text.length);
  const span = spanOf(joined);
  const graded =
    hasTeacherMarks(typed.text, typed.flags) ||
    Boolean(span && overlaps(own, ...span));
  const typedAnswer = cleanFill(typed.text.replace(/^\s*(→|->|⇒|=>)\s*/u, ""));
  if (!selected.length && typedAnswer) selected.push(typedAnswer);
  return {
    answer: { options: item.options, selected, ambiguous: selected.length > 1 },
    answered: selected.length > 0,
    graded,
    target: { mode: "append", index: paras.at(-1).end },
  };
}

/**
 * "((is)/am/are)": the student circled an option with brackets of their own
 * instead of formatting it. The group is found between the form's text before
 * and after it; an option inside its own "(…)" is the one chosen.
 */
function readCircledChoice(item, joined, form, formAt, paras, own) {
  const before = squeeze(form.text.slice(0, formAt)).out.toLowerCase();
  const afterWord = squeeze(form.text.slice(formAt + item.group.length))
    .out.split(" ")[0]
    .toLowerCase();
  const s = squeeze(joined.text);
  const lower = s.out.toLowerCase();
  if (!lower.startsWith(before)) return { unreadable: true };
  const open = lower.indexOf("(", before.length);
  const close = afterWord
    ? lower.indexOf(afterWord, open)
    : lower.lastIndexOf(")") + 1;
  if (open < 0 || close <= open) return { unreadable: true };
  const group = s.out.slice(open, close);
  const selected = item.options.filter((o) =>
    new RegExp(
      `\\(\\s*${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\)`,
      "i",
    ).test(group),
  );
  const restFrom = close >= s.map.length ? joined.text.length : s.map[close];
  const rest = slice(joined, restFrom, joined.text.length);
  const span = spanOf(joined);
  return {
    answer: { options: item.options, selected, ambiguous: selected.length > 1 },
    answered: selected.length > 0,
    graded:
      hasTeacherMarks(rest.text, rest.flags) ||
      Boolean(span && overlaps(own, ...span)),
    target: { mode: "append", index: paras.at(-1).end },
  };
}

/** Buổi 09 Ex4: the head nouns the student underlined, and the translation. */
function readUnderline(ex, item, paras, own) {
  const passage = paras[0];
  const form = ex.paras[item.parts[0].p];
  const formFlags = String(form.flags || "").split(",");
  const underlined = [];
  let word = "";
  for (let k = 0; k <= passage.text.length; k++) {
    const on =
      k < passage.text.length &&
      (passage.flags[k] || "").includes("u") &&
      !(formFlags[k] || "").includes("u");
    if (on) {
      word += passage.text[k];
    } else {
      if (word.trim()) underlined.push(word.trim());
      word = "";
    }
  }
  const restJoined = joinParagraphs(paras.slice(1));
  const dich = restJoined.text.search(/dịch\s*:/iu);
  const translation = cleanFill(
    dich >= 0
      ? restJoined.text.slice(dich).replace(/^dịch\s*:/iu, "")
      : restJoined.text,
  );
  const span = spanOf(joinParagraphs(paras));
  const graded =
    hasTeacherMarks(restJoined.text, restJoined.flags) ||
    Boolean(span && overlaps(own, ...span));
  return {
    answer: { underlined, translation },
    answered: underlined.length > 0 || Boolean(translation),
    graded,
    target: { mode: "append", index: paras.at(-1).end },
  };
}

export const ASKS_UNDERLINED = /underlined|gạch chân/iu;

/**
 * "Make Wh-questions for the underlined parts": the underlined text of a
 * question line (before its arrow), which the question must ask about. Null
 * when nothing is underlined.
 */
export function underlinedText({ text, flags }) {
  const arrow = text.search(/→|->|⇒|=>/u);
  const end = arrow >= 0 ? arrow : text.length;
  const parts = [];
  let run = "";
  for (let k = 0; k <= end; k++) {
    if (k < end && (flags[k] || "").includes("u") && text[k] !== "_") {
      run += text[k];
    } else {
      if (run.trim()) parts.push(run);
      run = "";
    }
  }
  const out = cleanFill(parts.join(" ")).replace(/[\s.?!,]+$/u, "");
  return out || null;
}

/**
 * underlinedText of an item, read on the student's doc: copies of the form
 * may underline what the blank form does not. Falls back to the form's.
 */
function underlinedPart(ex, item, paras) {
  if (!ASKS_UNDERLINED.test(ex.instruction || "")) return null;
  return (paras[0] && underlinedText(paras[0])) || item.underlined || null;
}

function readParagraphItem(ex, item, paraRegion, own) {
  const { paras, match, extras } = paraRegion;
  const indexes = [];
  for (const [n, { p }] of item.parts.entries()) {
    if (match[p] === null) {
      // Buổi 09 Ex4: the "____" lines under "Dịch:" may be gone.
      if (ex.layout === "underline_translate" && n > 0) continue;
      // A lone "→ ____" line the student replaced: fine once the question is there.
      if (ARROW_START.test(ex.paras[p].text) && indexes.length) continue;
      return { unreadable: true };
    }
    indexes.push(match[p], ...extras[p]);
  }
  const studentParas = [...new Set(indexes)]
    .sort((a, b) => a - b)
    .map((i) => paras[i]);

  if (ex.layout === "choose") return readChoose(ex, item, studentParas, own);
  if (ex.layout === "underline_translate") {
    return readUnderline(ex, item, studentParas, own);
  }

  const formText = item.parts.map(({ p }) => ex.paras[p].text).join("\n");
  const region = readRegion(formText, studentParas);
  if (!region) return { unreadable: true };
  const span = spanOf(region.joined);

  if (ex.layout === "passage") {
    const fill = region.split.fills[item.slot];
    if (!fill) return { unreadable: true };
    const next =
      region.split.fills[item.slot + 1]?.from ?? region.split.trailing.from;
    const after = region.joined.text.slice(fill.to, Math.max(fill.to, next));
    const at = indexAfter(region.joined, fill.to);
    const graded =
      TEACHER_MARK.test(fill.text) ||
      /^\s*[✅❌✔✓]/u.test(after) ||
      (at !== null && overlaps(own, at, at + 1));
    return {
      answer: fill.text,
      answered: Boolean(fill.text),
      graded,
      target: { mode: "inline", index: at },
    };
  }

  const graded =
    regionMarked(region) || Boolean(span && overlaps(own, ...span));
  const { fills, trailing } = region.split;
  const answer =
    item.kind === "line"
      ? answerText(region)
      : {
          fills: fills.map((f) => f.text),
          sentence: filledText(formText, fills),
          ...(trailing.text ? { extra: trailing.text } : {}),
        };
  const underlined = underlinedPart(ex, item, studentParas);
  return {
    ...(underlined ? { underlined } : {}),
    answer,
    answered: fills.some((f) => f.text) || Boolean(trailing.text),
    graded,
    target: { mode: "append", index: studentParas.at(-1).end },
  };
}

/**
 * Every item of a lesson tab, read against the form.
 *
 * @returns {{lesson: ?object, items: object[], warnings: object[]}} each item:
 *   {key, n, exerciseId, kind, layout, optional, instruction, prompt, hint?,
 *    labels?, options?, slot?, underlined?, answer, answered, graded, target}
 *   — or the same head with `unreadable: true`. Warnings ({code, …}): exercises not found,
 *   headers the form does not have, items that could not be read.
 */
export function collectHsItems(
  tab,
  { lessonId, lessonName, lesson: override } = {},
) {
  const lesson =
    override ||
    hsLessonFor({
      lessonId,
      lessonName: lessonName ?? tab?.tabProperties?.title,
    });
  if (!lesson) {
    return { lesson: null, items: [], warnings: [{ code: "hsLessonUnknown" }] };
  }
  const { located, unknown, missing } = locateExercises(tab, lesson);
  const own = ownRanges(tab);
  const warnings = [];
  for (const header of unknown) {
    warnings.push({ code: "hsUnknownExercise", header });
  }
  for (const id of missing) {
    const ex = lesson.exercises.find((e) => e.id === id);
    if (!ex.optional && ex.items.length) {
      warnings.push({ code: "hsExerciseMissing", exercise: id });
    }
  }

  const items = [];
  for (const { ex, paras, tables } of located) {
    const paraRegion = {
      paras,
      ...alignParagraphs(
        ex.paras.map((p) => p.text),
        paras.map((p) => p.text),
      ),
    };
    let unreadable = 0;
    for (const item of ex.items) {
      const head = {
        key: item.key,
        n: item.n,
        exerciseId: ex.id,
        kind: item.kind,
        layout: ex.layout,
        optional: ex.optional,
        instruction: ex.instruction,
        prompt: item.prompt,
        ...(item.hint ? { hint: item.hint } : {}),
        ...(item.labels ? { labels: item.labels } : {}),
        ...(item.options ? { options: item.options } : {}),
        ...(item.slot !== undefined ? { slot: item.slot } : {}),
      };
      let read;
      try {
        read =
          item.parts[0].t !== undefined
            ? readTableItem(ex, item, tables, own)
            : readParagraphItem(ex, item, paraRegion, own);
      } catch {
        read = { unreadable: true };
      }
      if (read.unreadable) unreadable += 1;
      items.push({ ...head, ...read });
    }
    if (unreadable) {
      warnings.push({
        code: "hsUnreadableItems",
        exercise: ex.id,
        count: unreadable,
      });
    }
  }
  return { lesson, items, warnings };
}

/** The items a grading run sends: written, readable, not corrected yet. */
export const selectHsItemsToGrade = (items) =>
  items.filter((i) => !i.unreadable && i.answered && !i.graded);

// ---------------------------------------------------------------------------
// Writing corrections
// ---------------------------------------------------------------------------

/** FNV-1a, base 36: a short, stable fingerprint (not a security hash). */
export function hsHash(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const stripParens = (text) =>
  String(text || "")
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();

/**
 * The text written for one graded item. `result` is the grader's verdict:
 * {correct, corrected?, explanation?, expected?, translation?}. `**…**`
 * marks bold. A right answer gets the tick alone — the teachers asked for no
 * "Well-done!", so a page with many mistakes is not a wall of red words.
 *
 *   inline (a blank in a passage)  "✅"  |  " ❌ → hall"
 *   cell   (the "Chữa bài" column) "✅" | "Câu đúng: … (…)"
 *   append (end of the answer)     " ✅" | ⏎ "Câu đúng: … (…)"
 *
 * `translation` (the rearrange-the-words exercises) follows a correction
 * only: ⏎ "Câu đúng: … (…) Dịch: …". A right sentence keeps the tick alone —
 * the teachers translate only what the pupil got wrong.
 */
export function formatHsFeedback(item, result) {
  const mode = item.target?.mode;
  // Never a "\n": it would start a new (numbered) paragraph.
  const oneLine = (text) =>
    String(text || "")
      .trim()
      .replace(/\s*\r?\n\s*/g, LINE_BREAK);
  const explanation = oneLine(stripParens(result.explanation));
  const why = explanation ? ` (${explanation})` : "";
  if (mode === "inline") {
    if (result.correct) return "✅";
    const expected = oneLine(result.expected || result.corrected);
    return expected ? ` ❌ → **${expected}**` : " ❌";
  }
  if (result.correct) return mode === "cell" ? "✅" : " ✅";
  const translation = oneLine(result.translation);
  const meaning = translation ? ` Dịch: ${translation}` : "";
  const corrected = oneLine(result.corrected);
  const body = corrected ? `Câu đúng: ${corrected}${why}` : explanation;
  if (!body) return mode === "cell" ? `❌${meaning}` : ` ❌${meaning}`;
  return mode === "cell"
    ? `${body}${meaning}`
    : `${LINE_BREAK}${body}${meaning}`;
}

/** Name of the named range around one inserted text. */
export const hsRangeName = (key, plain) =>
  `${HS_NAMED_RANGE_PREFIX}${hsHash(key)}:${hsHash(plain)}`;

/**
 * Pairs freshly read items with the grader's results into writes. Called on
 * the doc as it is AT WRITE TIME: positions come from that read, and an item
 * that got corrected since it was graded (a teacher, another run) is dropped.
 *
 * @param items   collectHsItems(tab).items, read just before writing
 * @param results Map|object key → {correct, corrected?, explanation?, expected?}
 * @returns {{writes: Array<{key, index, text}>, skipped: string[]}}
 */
export function planHsWrites(items, results) {
  const get = (key) =>
    results instanceof Map ? results.get(key) : results?.[key];
  const writes = [];
  const skipped = [];
  for (const item of items) {
    const result = get(item.key);
    if (!result) continue;
    if (
      item.unreadable ||
      item.graded ||
      !item.answered ||
      item.target?.index === undefined ||
      item.target?.index === null
    ) {
      skipped.push(item.key);
      continue;
    }
    writes.push({
      key: item.key,
      index: item.target.index,
      text: formatHsFeedback(item, result),
    });
  }
  return { writes, skipped };
}

/**
 * Docs batchUpdate requests for `writes`: each text inserted at its index in
 * red (the student's highlight/underline not inherited), `**bold**` applied,
 * and the whole insert wrapped in a named range (hsRangeName). Sorted from the
 * end of the tab backwards, so no insert moves the index of another.
 */
export function buildHsFeedbackRequests(writes, tabId) {
  const ordered = writes
    .map((w, order) => ({ ...w, order }))
    .sort((a, b) => b.index - a.index || b.order - a.order);
  const requests = [];
  for (const { key, index, text } of ordered) {
    const bold = [];
    let plain = "";
    const re = /\*\*(.+?)\*\*/gs;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      plain += text.slice(last, m.index);
      bold.push([plain.length, plain.length + m[1].length]);
      plain += m[1];
      last = m.index + m[0].length;
    }
    plain += text.slice(last);
    if (!plain) continue;
    const range = (from, to) => ({
      startIndex: index + from,
      endIndex: index + to,
      tabId,
    });
    requests.push({
      insertText: { location: { index, tabId }, text: plain },
    });
    requests.push({
      updateTextStyle: {
        range: range(0, plain.length),
        textStyle: {
          foregroundColor: FEEDBACK_COLOR,
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
        },
        fields:
          "foregroundColor,bold,italic,underline,strikethrough,backgroundColor",
      },
    });
    for (const [from, to] of bold) {
      requests.push({
        updateTextStyle: {
          range: range(from, to),
          textStyle: { bold: true },
          fields: "bold",
        },
      });
    }
    requests.push({
      createNamedRange: {
        name: hsRangeName(key, plain),
        range: range(0, plain.length),
      },
    });
  }
  return requests;
}

/** Every character of a tab by Docs index (paragraphs inside tables too). */
function tabCharsByIndex(tab) {
  const byIndex = new Map();
  const walk = (content) => {
    for (const b of content || []) {
      if (b.paragraph) {
        for (const el of b.paragraph.elements || []) {
          const text = el.textRun?.content;
          if (text === undefined) continue;
          for (let i = 0; i < text.length; i++) {
            byIndex.set(el.startIndex + i, text[i]);
          }
        }
      } else if (b.table) {
        for (const row of b.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      }
    }
  };
  walk(tab.documentTab?.body?.content);
  return byIndex;
}

/** The text currently inside each of this module's named ranges. */
function ownFeedback(tab) {
  const chars = tabCharsByIndex(tab);
  const out = [];
  const named = tab.documentTab?.namedRanges || {};
  for (const [name, group] of Object.entries(named)) {
    if (!name.startsWith(HS_NAMED_RANGE_PREFIX)) continue;
    const expected = name.split(":").at(-1);
    for (const nr of group.namedRanges || []) {
      const ranges = [...(nr.ranges || [])].sort(
        (a, b) => a.startIndex - b.startIndex,
      );
      let text = "";
      for (const r of ranges) {
        for (let i = r.startIndex; i < r.endIndex; i++) {
          text += chars.get(i) ?? "";
        }
      }
      out.push({
        name,
        namedRangeId: nr.namedRangeId,
        ranges,
        text,
        intact: hsHash(text) === expected,
      });
    }
  }
  return out;
}

/**
 * Whether every write of a run is in the doc read back after it: its named
 * range exists and still holds exactly the text written.
 */
export function matchesOwnHsFeedback(writes, tab) {
  if (!writes.length) return false;
  const present = new Set(
    ownFeedback(tab)
      .filter((f) => f.intact)
      .map((f) => f.name),
  );
  return writes.every((w) =>
    present.has(hsRangeName(w.key, w.text.replace(/\*\*(.+?)\*\*/gs, "$1"))),
  );
}

/**
 * "Xóa feedback" for an HS tab: removes the text of every named range this
 * module wrote whose text is still exactly what it wrote. A range a teacher
 * edited into — or whose text is gone — is left in place and counted as kept:
 * better to leave AI text behind than to delete a teacher's.
 *
 * @returns {{requests: object[], removed: number, kept: number}}
 */
export function buildHsClearRequests(tab) {
  const tabId = tab.tabProperties?.tabId;
  const found = ownFeedback(tab);
  const ranges = [];
  let removed = 0;
  let kept = 0;
  const names = new Set();
  for (const f of found) {
    if (!f.intact || !f.text) {
      kept += 1;
      continue;
    }
    removed += 1;
    names.add(f.name);
    ranges.push(...f.ranges);
  }
  const requests = ranges
    .sort((a, b) => b.startIndex - a.startIndex)
    .map((r) => ({
      deleteContentRange: {
        range: { startIndex: r.startIndex, endIndex: r.endIndex, tabId },
      },
    }));
  for (const name of names) {
    requests.push({
      deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } },
    });
  }
  return { requests, removed, kept };
}
