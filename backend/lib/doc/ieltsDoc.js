/**
 * IELTS Writing tables in a student's doc — the template of the "ielts"
 * grading profile (backend lib/courses.js). Deliberately a module of its own:
 * the Basic detector (docTableDetect.js) and parser (docParser.js) are not
 * touched, and this one is only ever called for IELTS classes.
 *
 * One table per piece of writing:
 *
 *   | IELTS WRITING – TASK 1  (or TASK 2 / ĐOẠN VĂN)  |                     |
 *   | Đề bài                                          | <prompt + chart(s)> |
 *   | Bài làm                                         | <student's writing> |
 *   | GV chữa                                         | <empty: AI writes>  |
 *
 * All three labels AND the title are required, so a Basic table that happens
 * to mention "IELTS" is never taken for one. Each table yields ONE row entry
 * shaped like the paragraph entries of collectExerciseRows (qCell = the
 * writing, fbCell = the "GV chữa" cell), so docWriter's buildFeedbackRequests,
 * targetsAlreadyFilled and matchesOwnFeedback work on it unchanged.
 *
 * The teachers' own layout ("columns", buổi 4 of the IELTS docs): one row of
 * two cells, each starting with a bold heading line —
 *
 *   | Bài viết của học viên (Task 1)  | GV chữa/nhận xét            |
 *   | <student's writing>             | <empty: AI writes below it> |
 *
 * Or the lesson's own writing table, kept as it is, with a last row added
 * ("below"):
 *
 *   | Intro: <student>                     |
 *   | Overview: <student>                  |
 *   | GV chữa/nhận xét (Đoạn văn)          |  <empty: AI writes below it>
 *
 * The current template ("pair", asked for by the teachers on 2026-10-07): the
 * lesson's writing table as it is, then a table of its own right below it,
 * then a "NHẬN XÉT" line —
 *
 *   | Intro: <student>                                   |
 *   | Overview: <student>                                |
 *
 *   | GV chữa/nhận xét          | BẢN CẢI THIỆN          |
 *   | <AI: corrected writing>   | <AI: improved version> |
 *   NHẬN XÉT
 *   <AI: comments per criterion, general comment, advice>
 *
 * And short sentences ("sentences"): the exercise's own table with a last
 * column headed "GV chữa/nhận xét" in its first row; the AI writes into that
 * column, one row at a time ("✅" when the sentence is right).
 *
 *   | Loại chủ ngữ   | Câu mô tả       | GV chữa/nhận xét     |
 *   | Chủ ngữ đơn vị | <student>       | <AI>                 |
 *
 * planIeltsTemplateUpdate turns a lesson of the older layouts (or of the
 * course's original doc, which has none) into these two.
 *
 * In all but the old one, the prompt and chart are the paragraphs right ABOVE
 * the table (after the "Exercise N" line). The task is the heading's "(Task 1)", "(Task 2)" or
 * "(Đoạn văn)" (on either heading); without one it is guessed from the
 * exercise line. The AI writes just below the "GV chữa/nhận xét" heading, wrapped in a named range
 * (IELTS_NAMED_RANGE_PREFIX) so "Xóa feedback" removes exactly what it wrote
 * and never the heading or a teacher's notes. Old-layout tables keep the
 * docWriter path byte for byte (buildIeltsFeedbackRequests delegates).
 *
 * Pure. The backend copies this file verbatim into
 * auto-check-exercise-be/backend/lib/doc/ — see the header of docWriter.js.
 */
import { getCellLines, getCellText } from "./docParser.js";
import {
  buildClearFeedbackRequests,
  buildFeedbackRequests,
  matchesOwnFeedback,
  targetsAlreadyFilled,
} from "./docWriter.js";

export const KIND_IELTS_WRITING = "ielts_writing";
/** One row of a short-sentence table (a row entry). */
export const KIND_IELTS_SENTENCE = "ielts_sentence";
/** A short-sentence table to grade: all its rows in one item. */
export const KIND_IELTS_SENTENCES = "ielts_sentences";

const TITLE = /ielts\s*writing/i;
const TASK_1 = /task\s*1\b/i;
const TASK_2 = /task\s*2\b/i;
const TASK_PARAGRAPH = /đo[aạ]n\s*v[aă]n|paragraph/i;
/** Row labels are anchored to the WHOLE cell: "Đề bài" but not "Đề bài 1: …". */
const PROMPT_LABEL = /^\s*đ[eề]\s*b[aà]i\s*:?\s*$/i;
const ESSAY_LABEL =
  /^\s*b[aà]i\s*l[aà]m(\s*c[uủ]a\s*h[oọ]c\s*vi[eê]n)?\s*:?\s*$/i;
const FEEDBACK_LABEL = /^\s*(gv\s*(ch[uữ]a|s[uử]a)|ch[uữ]a\s*b[aà]i)\s*:?\s*$/i;

/**
 * Layout of an entry: the old 3-row template, the teachers' 2 columns, or
 * the lesson's own writing table with a "GV chữa/nhận xét" row added at its
 * bottom ("below").
 */
export const LAYOUT_ROWS = "rows";
export const LAYOUT_COLUMNS = "columns";
export const LAYOUT_BELOW = "below";
export const LAYOUT_PAIR = "pair";
export const LAYOUT_SENTENCES = "sentences";
/** Layouts whose feedback this module writes itself, in named ranges. */
const HEADED_LAYOUTS = [
  LAYOUT_COLUMNS,
  LAYOUT_BELOW,
  LAYOUT_PAIR,
  LAYOUT_SENTENCES,
];
const headedLayout = (entry) => HEADED_LAYOUTS.includes(entry?.layout);

/** The template's headings, as the converter writes them. */
export const FEEDBACK_HEADING = "GV chữa/nhận xét";
export const IMPROVED_HEADING = "BẢN CẢI THIỆN";
export const REVIEW_HEADING = "NHẬN XÉT";
export const SENTENCE_HEADING = "Câu của học viên";
/** Heading of the improved-version cell: "BẢN CẢI THIỆN", "Bài cải thiện". */
const IMPROVED_HEAD = /^\s*(b[aả]n|b[aà]i)\s*c[aả]i\s*thi[eệ]n\s*:?\s*$/iu;
/** A heading naming the teacher, or a comment: "GV …", "Cô …", "… nhận xét". */
const TEACHER_COLUMN =
  /(^|[^\p{L}])(gv|gi[aá]o\s*vi[eê]n|c[oô])(?![\p{L}])|nh[aậ]n\s*x[eé]t/iu;
/** The line below the pair table that the comments go under. */
const REVIEW_HEAD = /^\s*nh[aậ]n\s*x[eé]t\s*:?\s*$/iu;

/**
 * Heading of the student's cell in the 2-column layout, and whatever follows
 * it on that line: "Bài viết của học viên", "Bài làm (Task 2)", …
 */
const COLUMN_ESSAY_HEAD =
  /^\s*b[aà]i\s*(vi[eế]t|l[aà]m)(\s*c[uủ]a\s*(h[oọ]c\s*vi[eê]n|hv|em))?(?<rest>.*)$/iu;
/** What may follow that heading on its line: only a task, in any wrapping. */
const COLUMN_ESSAY_REST = /^[\s(–—:-]*(?<task>[^)]*?)[\s):.]*$/u;
/** Heading of the feedback cell: "GV chữa/nhận xét", "Cô chữa", "Nhận xét". */
const COLUMN_FEEDBACK_HEAD =
  /^\s*((gv|gi[aá]o\s*vi[eê]n|c[oô])\s*)?((ch[uữ]a|s[uử]a)(\s*b[aà]i)?|nh[aậ]n\s*x[eé]t)(\s*(\/|&|và|,|-)\s*((ch[uữ]a|s[uử]a)(\s*b[aà]i)?|nh[aậ]n\s*x[eé]t))?(\s*c[uủ]a\s*(gv|gi[aá]o\s*vi[eê]n|c[oô]))?\s*:?\s*$/iu;
/** An exercise line above a table: "Exercise 2: …", "Bài tập 3 …". */
const EXERCISE_LINE = /^\s*(exercise|ex\.?|b[aà]i\s*t[aậ]p)\s*\d+/iu;
/** The exercise asks for a whole essay (Task 1 / Task 2), not a paragraph. */
const FULL_ESSAY = /ho[aà]n\s*ch[iỉ]nh|full\s*essay|complete\s*essay/iu;
/** A line holding only a part label of the template: "Intro:", "Body 1:". */
const PART_LABEL_LINE =
  /^\s*(intro(duction)?|overview|body\s*\d*|conclusion|m[ởo]\s*b[aà]i|k[ếe]t\s*b[aà]i|th[âa]n\s*b[aà]i\s*\d*)\s*:?\s*$/iu;
/** Prompt text kept from above a table: enough for any IELTS prompt. */
const MAX_COLUMN_PROMPT = 4000;

function listTables(tab) {
  return (tab?.documentTab?.body?.content || [])
    .flatMap((block) => block.table || [])
    .map((table, tableIdx) => ({ tableIdx, table }));
}

/** The row's label cell (first cell with text) and its index, or null. */
function rowLabel(row) {
  const cells = row?.tableCells || [];
  for (let i = 0; i < cells.length; i++) {
    const text = getCellText(cells[i]).trim();
    if (text) return { index: i, text };
  }
  return null;
}

/** The cell right after the label that Docs can address (has content). */
function cellAfter(row, labelIndex) {
  const cells = row?.tableCells || [];
  for (let i = labelIndex + 1; i < cells.length; i++) {
    if (cells[i]?.content) return cells[i];
  }
  return null;
}

function taskOf(title) {
  if (TASK_1.test(title)) return "task1";
  if (TASK_2.test(title)) return "task2";
  if (TASK_PARAGRAPH.test(title)) return "paragraph";
  return null;
}

/**
 * Reads one table as an IELTS Writing table.
 *
 * @returns {{task, promptCell, essayCell, fbCell,
 *   promptRowIdx, essayRowIdx, feedbackRowIdx}|null} null when this is not
 *   an IELTS table. `{invalid: true}` when the title says IELTS WRITING but
 *   the rest of the template is missing — reported, never guessed at.
 */
export function resolveIeltsTable(table) {
  const rows = table?.tableRows || [];
  let title = null;
  const found = {};
  rows.forEach((row, rowIdx) => {
    const label = rowLabel(row);
    if (!label) return;
    if (title === null && TITLE.test(label.text)) {
      title = label.text;
      return;
    }
    for (const [key, pattern] of [
      ["prompt", PROMPT_LABEL],
      ["essay", ESSAY_LABEL],
      ["feedback", FEEDBACK_LABEL],
    ]) {
      if (found[key] === undefined && pattern.test(label.text)) {
        found[key] = { rowIdx, cell: cellAfter(row, label.index) };
      }
    }
  });
  if (title === null) return null;

  const task = taskOf(title);
  const { prompt, essay, feedback } = found;
  if (
    !task ||
    !prompt?.cell ||
    !essay?.cell ||
    !feedback?.cell ||
    feedback.cell.content?.[0]?.startIndex === undefined
  ) {
    return { invalid: true };
  }
  return {
    task,
    promptCell: prompt.cell,
    essayCell: essay.cell,
    fbCell: feedback.cell,
    promptRowIdx: prompt.rowIdx,
    essayRowIdx: essay.rowIdx,
    feedbackRowIdx: feedback.rowIdx,
  };
}

/**
 * Ids of the images placed in one cell, in document order: inline images and
 * images anchored to one of its paragraphs. Nothing outside the cell counts.
 */
export function imageIdsInCell(cell) {
  return imageIdsInBlocks(cell?.content);
}

/** Ids of the images in a run of body blocks (paragraphs only). */
function imageIdsInBlocks(blocks) {
  const ids = [];
  for (const block of blocks || []) {
    const paragraph = block?.paragraph;
    if (!paragraph) continue;
    for (const element of paragraph.elements || []) {
      const id = element?.inlineObjectElement?.inlineObjectId;
      if (id) ids.push(id);
    }
    for (const id of paragraph.positionedObjectIds || []) ids.push(id);
  }
  return ids;
}

/** The first paragraph of a cell that holds text, with its block. */
function headingOf(cell) {
  for (const block of cell?.content || []) {
    if (!block?.paragraph) continue;
    const text = getCellLines({ content: [block] })
      .join(" ")
      .trim();
    if (text) return { block, text };
  }
  return null;
}

/**
 * Reads one row as the 2-column layout: a cell headed "Bài viết của học
 * viên" with, right after it, a cell headed "GV chữa/nhận xét".
 *
 * @returns {{essayCell, fbCell, essayText, feedbackText, taskLabel,
 *   insertAt}|null} insertAt: the Docs index just before the feedback
 *   heading's newline — where the AI's text goes.
 */
function resolveColumnRow(row) {
  const cells = row?.tableCells || [];
  for (let i = 0; i + 1 < cells.length; i++) {
    const essayHead = headingOf(cells[i]);
    const fbHead = headingOf(cells[i + 1]);
    if (!essayHead || !fbHead) continue;
    const essayMatch = COLUMN_ESSAY_HEAD.exec(essayHead.text.normalize("NFC"));
    if (!essayMatch) continue;
    const fbHeading = feedbackHeading(fbHead.text);
    if (!fbHeading) continue;

    const last = fbHead.block.paragraph.elements?.at(-1);
    const text = last?.textRun?.content;
    if (last?.endIndex === undefined || !text?.endsWith("\n")) continue;

    // "(Task 1)" after the heading names the task; anything else on that
    // line is the student's first words, typed right after it.
    const rest = essayMatch.groups.rest || "";
    const wrapped = COLUMN_ESSAY_REST.exec(rest);
    const essayTask = wrapped ? taskOf(wrapped.groups.task) : null;
    const firstLine =
      essayTask || !rest.trim() ? "" : rest.replace(/^[\s:–—-]+/u, "");
    const taskLabel = essayTask || fbHeading.taskLabel;
    const essayLines = getCellLines(cells[i]).slice(1);
    const feedbackLines = getCellLines(cells[i + 1]).slice(1);
    return {
      essayCell: cells[i],
      fbCell: cells[i + 1],
      essayText: [firstLine, ...essayLines].filter(Boolean).join("\n"),
      feedbackText: feedbackLines.join("\n"),
      taskLabel,
      insertAt: last.endIndex - 1,
    };
  }
  return null;
}

/**
 * A feedback heading — "GV chữa/nhận xét", optionally naming the task:
 * "GV chữa/nhận xét (Task 1)". Null when the text is not one.
 */
function feedbackHeading(text) {
  const t = String(text ?? "").normalize("NFC");
  const m = /^(?<head>.*?)\s*[(–—-]\s*(?<task>[^()]*?)\s*\)?\s*:?\s*$/u.exec(t);
  const task = m ? taskOf(m.groups.task) : null;
  if (task && COLUMN_FEEDBACK_HEAD.test(m.groups.head)) {
    return { taskLabel: task };
  }
  return COLUMN_FEEDBACK_HEAD.test(t) ? { taskLabel: null } : null;
}

/**
 * Reads a table as the "below" layout: the lesson's own writing rows (Intro,
 * Overview, … or one cell), then a last row headed "GV chữa/nhận xét" — the
 * AI writes below that heading. The writing is every row above it.
 *
 * @returns {{rowIdx, essayCell, fbCell, essayText, feedbackText, taskLabel,
 *   insertAt}|null}
 */
function resolveBelowTable(table) {
  const rows = table?.tableRows || [];
  for (let r = rows.length - 1; r >= 1; r--) {
    const cell = (rows[r].tableCells || []).find((c) => headingOf(c));
    if (!cell) continue; // an empty trailing row
    const head = headingOf(cell);
    const heading = feedbackHeading(head.text);
    if (!heading) return null;
    const last = head.block.paragraph.elements?.at(-1);
    const text = last?.textRun?.content;
    if (last?.endIndex === undefined || !text?.endsWith("\n")) return null;
    // Rows and cells above, in reading order; a merged cell's placeholders
    // hold nothing, so they add nothing.
    const essayText = rows
      .slice(0, r)
      .flatMap((row) => (row.tableCells || []).flatMap((c) => getCellLines(c)))
      .join("\n");
    return {
      rowIdx: r,
      essayCell: rows[0].tableCells?.[0] || null,
      fbCell: cell,
      essayText,
      feedbackText: getCellLines(cell).slice(1).join("\n"),
      taskLabel: heading.taskLabel,
      insertAt: last.endIndex - 1,
    };
  }
  return null;
}

/** The Docs index just before a heading paragraph's newline, or null. */
function endOfHeading(head) {
  const last = head?.block?.paragraph?.elements?.at(-1);
  if (last?.endIndex === undefined || !last.textRun?.content?.endsWith("\n")) {
    return null;
  }
  return last.endIndex - 1;
}

/**
 * Reads a table as the feedback table of the "pair" layout: one row of two
 * cells headed "GV chữa/nhận xét" and "BẢN CẢI THIỆN".
 *
 * @returns {{leftCell, rightCell, taskLabel, leftAt, rightAt,
 *   feedbackText}|null} leftAt / rightAt: where the corrected writing and
 *   the improved version go (just before each heading's newline).
 */
function resolvePairTable(table) {
  const rows = table?.tableRows || [];
  if (rows.length !== 1) return null;
  const cells = rows[0].tableCells || [];
  if (cells.length !== 2) return null;
  const left = headingOf(cells[0]);
  const right = headingOf(cells[1]);
  if (!left || !right) return null;
  const heading = feedbackHeading(left.text);
  if (!heading || !IMPROVED_HEAD.test(right.text.normalize("NFC"))) {
    return null;
  }
  const leftAt = endOfHeading(left);
  const rightAt = endOfHeading(right);
  if (leftAt === null || rightAt === null) return null;
  return {
    leftCell: cells[0],
    rightCell: cells[1],
    taskLabel: heading.taskLabel,
    leftAt,
    rightAt,
    feedbackText: [
      ...getCellLines(cells[0]).slice(1),
      ...getCellLines(cells[1]).slice(1),
    ].join("\n"),
  };
}

/**
 * The writing in the table above a pair table: every cell's lines, except a
 * cell headed "GV chữa/nhận xét" (an older template's feedback, kept when the
 * lesson was converted after grading) and the "Bài viết của học viên (Task 1)"
 * heading of the teachers' 2-column table, whose task it reports.
 */
function essayOfTable(table) {
  const lines = [];
  let taskLabel = null;
  for (const row of table?.tableRows || []) {
    for (const cell of row.tableCells || []) {
      const head = headingOf(cell);
      if (!head || feedbackHeading(head.text)) continue;
      let cellLines = getCellLines(cell);
      const essayHead = COLUMN_ESSAY_HEAD.exec(cellLines[0].normalize("NFC"));
      if (essayHead) {
        const rest = essayHead.groups.rest || "";
        const wrapped = COLUMN_ESSAY_REST.exec(rest);
        const task = wrapped ? taskOf(wrapped.groups.task) : null;
        taskLabel ||= task;
        const first =
          task || !rest.trim() ? "" : rest.replace(/^[\s:–—-]+/u, "");
        cellLines = [first, ...cellLines.slice(1)].filter(Boolean);
      }
      lines.push(...cellLines);
    }
  }
  return { essayText: lines.join("\n"), taskLabel };
}

/** True when a block is a paragraph with neither text nor an image. */
function isBlankParagraph(block) {
  if (!block?.paragraph) return false;
  const text = getCellLines({ content: [block] }).join("");
  return !text.trim() && !imageIdsInBlocks([block]).length;
}

/** Index in `body` of the next block after `at` that is not a blank line. */
function nextBlockAt(body, at) {
  let i = at + 1;
  while (i < body.length && isBlankParagraph(body[i])) i++;
  return i < body.length ? i : -1;
}

/** Index in `body` of the block before `at` that is not a blank line. */
function previousBlockAt(body, at) {
  let i = at - 1;
  while (i >= 0 && isBlankParagraph(body[i])) i--;
  return i;
}

/** The "NHẬN XÉT" paragraph right below the pair table at `at`, or null. */
function reviewHeadingAfter(body, at) {
  const i = nextBlockAt(body, at);
  const block = body[i];
  if (!block?.paragraph) return null;
  const text = getCellLines({ content: [block] })
    .join(" ")
    .trim();
  if (!REVIEW_HEAD.test(text.normalize("NFC"))) return null;
  const insertAt = endOfHeading({ block });
  return insertAt === null ? null : { at: i, insertAt };
}

/** "Sđơn vị… + V + adv: <sentence>" → "<sentence>"; a short label only. */
const withoutLabel = (text) =>
  String(text ?? "")
    .replace(/^[^:\n]{1,80}:/u, "")
    .trim();

/**
 * True when a sentence row holds the student's writing: a cell past the first
 * holds text, or the first holds more than its label — "Mô tả bước 1:" or
 * "Chủ ngữ đơn vị" alone is not written yet. With one column, anything past
 * its label is. `headers` (the first row's titles, when it has them) mark the
 * teacher's columns — hints, questions, the given problems — whose text is
 * never the student's.
 */
function sentenceWritten(texts, headers = []) {
  // A hint cell ("Gợi ý: • …", buổi 18's last row) is the teacher's too.
  // So is a structure to follow: "The figure for + N + in A was …".
  const own = texts.map((t, i) =>
    HINT_CELL.test(t) ||
    FORMULA.test(withoutLabel(t)) ||
    GIVEN_COLUMN.test(headers[i] || "")
      ? ""
      : t,
  );
  if (own.length === 1) return withoutLabel(own[0]) !== "";
  return own.some(
    (t, i) => (i === 0 ? /:/.test(t) : true) && withoutLabel(t) !== "",
  );
}
const HINT_CELL = /^\s*g[oợ]i\s*ý(?![\p{L}])/iu;
/** A sentence pattern with slots joined by "+", never a student's sentence. */
const FORMULA = /\S\s\+\s\S/u;
/** "Gợi ý", "Câu hỏi gợi ý", "Problems", "Đề bài": filled in by the teacher. */
const GIVEN_COLUMN =
  /g[oợ]i\s*ý|c[aâ]u\s*h[oỏ]i|question|hint|problems?(?![\p{L}])|đ[eề]\s*b[aà]i/iu;

/**
 * Reads a table as a short-sentence table: its first row's LAST cell holds
 * only a "GV chữa/nhận xét" heading, and every row below gets the AI's
 * comment in that column. Rows whose cells do not line up with the first row
 * (merged cells) are left out.
 *
 * @returns {{columns: string[], rows: Array<{rowIdx, row, cells: string[],
 *   fbCell, insertAt, feedbackText, answered: boolean}>}|null}
 */
function resolveSentenceTable(table) {
  const rows = table?.tableRows || [];
  if (rows.length < 2) return null;
  const header = rows[0].tableCells || [];
  if (header.length < 2) return null;
  // A row of titles, one per column — a merged title cell (Basic's
  // "Bài tập viết đoạn văn" header) is not one.
  const titled = header.every(
    (c) => getCellText(c).trim() && (c.tableCellStyle?.columnSpan || 1) === 1,
  );
  if (!titled) return null;
  const last = header.at(-1);
  const head = headingOf(last);
  if (!head || getCellLines(last).length !== 1) return null;
  // The teacher's column ("GV chữa/nhận xét", "Cô nhận xét") — not Basic's
  // own "Chữa bài" column, which a Basic table has in the same place.
  if (!feedbackHeading(head.text) || !TEACHER_COLUMN.test(head.text)) {
    return null;
  }
  const fbCol = header.length - 1;
  const titles = header.slice(0, fbCol).map((c) => getCellText(c));
  const out = [];
  // A comment cell merged down over the rows below hides theirs: Docs still
  // lists the hidden cells, but text put there would not be seen with its
  // row — those rows get no comment rather than a misplaced one.
  let fbHiddenUntil = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r].tableCells || [];
    const fbCell = cells[fbCol];
    const insertAt = fbCell?.content?.[0]?.startIndex;
    if (r <= fbHiddenUntil) continue;
    fbHiddenUntil = r + (fbCell?.tableCellStyle?.rowSpan || 1) - 1;
    if (cells.length !== header.length || insertAt === undefined) continue;
    const texts = cells.slice(0, fbCol).map((c) => getCellText(c));
    const answered = sentenceWritten(texts, titles);
    out.push({
      rowIdx: r,
      row: rows[r],
      cells: texts,
      fbCell,
      insertAt,
      feedbackText: getCellText(fbCell),
      answered,
    });
  }
  return {
    columns: header.slice(0, fbCol).map((c) => getCellText(c)),
    rows: out,
  };
}

/** A table the student writes in, or its feedback table: any IELTS layout. */
const isWritingTable = (table) =>
  resolveIeltsTable(table) !== null ||
  (table?.tableRows || []).some((row) => resolveColumnRow(row)) ||
  resolveBelowTable(table) !== null ||
  resolvePairTable(table) !== null ||
  resolveSentenceTable(table) !== null;

/** Vietnamese letters: a hint or an instruction, never an IELTS prompt. */
const VIETNAMESE =
  /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/iu;

/**
 * The prompt above a 2-column table, with the exercise line in front so the
 * model knows what was asked, and the images among its paragraphs. It runs
 * up from the table to the exercise line, past the tables in between (the
 * outline, the FRESH/SHEEP ideas) — or to the previous writing table, when an
 * exercise has several prompts: then the hints of the prompt before ("Gợi
 * ý: …", in Vietnamese) are dropped, the prompt itself being English.
 */
function promptAbove(body, tableAt, skip = new Set()) {
  let start = 0;
  let exercise = null;
  let afterWriting = false;
  for (let i = tableAt - 1; i >= 0; i--) {
    const block = body[i];
    if (block?.table) {
      if (isWritingTable(block.table)) {
        start = i + 1;
        afterWriting = true;
        break;
      }
      continue;
    }
    const text = block?.paragraph
      ? getCellLines({ content: [block] })
          .join(" ")
          .trim()
      : "";
    if (EXERCISE_LINE.test(text)) {
      exercise = text;
      start = i + 1;
      break;
    }
  }
  if (exercise === null) {
    // A second prompt of the same exercise: its line is above the table
    // before this one.
    for (let i = start - 1; i >= 0; i--) {
      const block = body[i];
      if (!block?.paragraph) continue;
      const text = getCellLines({ content: [block] })
        .join(" ")
        .trim();
      if (EXERCISE_LINE.test(text)) {
        exercise = text;
        break;
      }
    }
  }
  let blocks = body
    .slice(start, tableAt)
    .filter((b, k) => b?.paragraph && !skip.has(start + k));
  if (afterWriting) {
    // Only the run of hint lines right after that table: anything Vietnamese
    // further down (a hint above this table) stays, with its prompt.
    const firstPrompt = blocks.findIndex((b) => {
      const text = getCellLines({ content: [b] }).join(" ");
      return (
        (text.trim() || imageIdsInBlocks([b]).length) && !VIETNAMESE.test(text)
      );
    });
    if (firstPrompt > 0) blocks = blocks.slice(firstPrompt);
  }
  const lines = getCellLines({ content: blocks });
  let text = lines.join("\n");
  if (text.length > MAX_COLUMN_PROMPT) text = text.slice(-MAX_COLUMN_PROMPT);
  return {
    exercise: exercise || "",
    promptText: [exercise, text].filter(Boolean).join("\n"),
    imageIds: imageIdsInBlocks(blocks),
  };
}

/**
 * The prompt of a short-sentence table: the exercise line, the exercise's own
 * lines (up to its first table), the lines right above this table (its own
 * item: "1, Mô tả số liệu của Spain (1980 - 2010) - Giảm đều") and every
 * image from the exercise line down to the table — the chart is usually shown
 * once, under the exercise line.
 */
function sentencePromptAbove(body, tableAt, skip = new Set()) {
  let exerciseAt = -1;
  for (let i = tableAt - 1; i >= 0; i--) {
    const block = body[i];
    if (!block?.paragraph) continue;
    const text = getCellLines({ content: [block] })
      .join(" ")
      .trim();
    if (EXERCISE_LINE.test(text)) {
      exerciseAt = i;
      break;
    }
  }
  const linesOf = (from, to) =>
    getCellLines({
      content: body
        .slice(from, to)
        .filter((b, k) => b?.paragraph && !skip.has(from + k)),
    });
  let firstTable = tableAt;
  let previousTable = exerciseAt;
  for (let i = exerciseAt + 1; i < tableAt; i++) {
    if (!body[i]?.table) continue;
    if (firstTable === tableAt) firstTable = i;
    previousTable = i;
  }
  const exercise =
    exerciseAt >= 0 ? linesOf(exerciseAt, exerciseAt + 1).join(" ") : "";
  const intro = linesOf(exerciseAt + 1, firstTable);
  const own =
    previousTable > exerciseAt ? linesOf(previousTable + 1, tableAt) : [];
  let text = [...intro, ...own].join("\n");
  if (text.length > MAX_COLUMN_PROMPT) text = text.slice(-MAX_COLUMN_PROMPT);
  const imageIds = imageIdsInBlocks(
    body
      .slice(exerciseAt + 1, tableAt)
      .filter((b, k) => !skip.has(exerciseAt + 1 + k)),
  );
  return {
    promptText: [exercise, text].filter(Boolean).join("\n"),
    imageIds,
  };
}

/**
 * The task of a 2-column table without a "(Task …)" label: a whole essay is
 * Task 1 when it comes with a chart, else Task 2; anything else — Intro and
 * Overview, introductions, conclusions — is a paragraph (graded, no band).
 */
function guessColumnTask(exercise, imageIds) {
  if (!FULL_ESSAY.test(exercise)) return "paragraph";
  return imageIds.length ? "task1" : "task2";
}

/** The temporary download URL of one image of the tab, or null. */
export function imageUri(tab, objectId) {
  const doc = tab?.documentTab || {};
  const embedded =
    doc.inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject ||
    doc.positionedObjects?.[objectId]?.positionedObjectProperties
      ?.embeddedObject;
  return embedded?.imageProperties?.contentUri || null;
}

const normalizeTitle = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** "BUỔI 12", "Buổi 12", "buổi 012" → 12; null when there is no number. */
export function lessonNumberOf(name) {
  const match = /bu[oổ]i\s*0*(\d+)/u.exec(normalizeTitle(name));
  return match ? Number(match[1]) : null;
}

/** Every tab of the doc, child tabs included, in document order. */
function allTabs(tabs, out = []) {
  for (const tab of tabs || []) {
    out.push(tab);
    allTabs(tab.childTabs, out);
  }
  return out;
}

const hasIeltsTable = (tab) =>
  listTables(tab).some(({ table }) => isWritingTable(table));

const WRITING_TAB = /^writing\s*[-–:]?\s*bu[oổ]i\s*0*(\d+)$/u;
/** "Buổi 12", and a lesson tab named for its topic: "Buổi 22 (Maps)". */
const LESSON_TAB = /^bu[oổ]i\s*0*(\d+)(\s*[-–:(].*)?$/u;

/**
 * The tab holding a lesson's IELTS tables. The IELTS docs name a lesson's
 * tab "Buổi 12" and put the writing in a tab "Writing buổi 12" after it (the
 * first lessons: just "Writing", "Writing -DCadj"; buổi 21: "Writing
 * (Process)"; buổi 22 has no child tab, its lesson tab is "Buổi 22 (Maps)"),
 * while the course's lesson
 * is "BUỔI 12" — so the lesson is matched by its NUMBER, case-insensitively,
 * in this order:
 *   1. a "Writing buổi N" tab;
 *   2. a tab starting with "Writing" among the lesson's tabs — those from
 *      "Buổi N" up to the next "Buổi …" tab, in document order (child tabs
 *      or following siblings alike);
 *   3. a tab titled exactly like the lesson;
 *   4. the "Buổi N" tab itself.
 * The first of those with an IELTS WRITING table wins; with none, the first
 * one found (so the caller reports "no table" rather than "no tab"). Null
 * when none exists.
 */
export function findIeltsTab(tabs, lessonName) {
  const list = allTabs(tabs).filter((tab) => tab?.documentTab);
  const titleOf = (tab) => normalizeTitle(tab.tabProperties?.title);
  const number = lessonNumberOf(lessonName);
  const exact = normalizeTitle(lessonName);
  const titled = (pattern) => (tab) => {
    const match = pattern.exec(titleOf(tab));
    return Boolean(match) && Number(match[1]) === number;
  };

  const lessonTab = number === null ? -1 : list.findIndex(titled(LESSON_TAB));
  const lessonTabs = [];
  for (let i = lessonTab + 1; lessonTab >= 0 && i < list.length; i++) {
    if (LESSON_TAB.test(titleOf(list[i]))) break;
    lessonTabs.push(list[i]);
  }

  const candidates = [
    ...(number === null ? [] : list.filter(titled(WRITING_TAB))),
    ...lessonTabs.filter((tab) => titleOf(tab).startsWith("writing")),
    ...list.filter((tab) => titleOf(tab) === exact),
    ...(lessonTab >= 0 ? [list[lessonTab]] : []),
  ];
  return candidates.find(hasIeltsTable) || candidates[0] || null;
}

/**
 * Indexes in `body` of the paragraphs that are not part of any prompt: the
 * "NHẬN XÉT" line under a pair table and what the AI wrote outside tables
 * (its named ranges) — the comments of one exercise must never be read as
 * the prompt of the next.
 */
function aiWrittenBlocks(tab, body) {
  const ranges = Object.entries(tab?.documentTab?.namedRanges || {})
    .filter(([name]) => name.startsWith(IELTS_NAMED_RANGE_PREFIX))
    .flatMap(([, group]) => group.namedRanges || [])
    .flatMap((nr) => nr.ranges || []);
  const skip = new Set();
  body.forEach((block, at) => {
    if (!block?.paragraph) {
      if (block?.table && resolvePairTable(block.table)) {
        const review = reviewHeadingAfter(body, at);
        if (review) skip.add(review.at);
      }
      return;
    }
    const start = block.startIndex;
    if (ranges.some((r) => start >= r.startIndex && start < r.endIndex)) {
      skip.add(at);
    }
  });
  return skip;
}

/**
 * Every IELTS Writing table of a tab, as row entries (see the file header).
 *
 * @returns {{rows: object[], invalidTables: number[]}}
 */
export function collectIeltsRows(tab) {
  const rows = [];
  const invalidTables = [];
  const body = tab?.documentTab?.body?.content || [];
  const skip = aiWrittenBlocks(tab, body);
  // The table above a pair table is its writing: read with the pair table,
  // never on its own (it may still hold an older "GV chữa/nhận xét" row).
  const essayOfPair = new Map();
  body.forEach((block, at) => {
    if (!block?.table || !resolvePairTable(block.table)) return;
    const essayAt = previousBlockAt(body, at);
    if (body[essayAt]?.table && !resolvePairTable(body[essayAt].table)) {
      essayOfPair.set(at, essayAt);
    }
  });
  const essayTables = new Set(essayOfPair.values());
  let tableIdx = -1;
  body.forEach((block, at) => {
    const table = block?.table;
    if (!table) return;
    tableIdx++;
    if (essayTables.has(at)) return;
    const pair = resolvePairTable(table);
    if (pair) {
      const essayAt = essayOfPair.get(at);
      if (essayAt === undefined) return; // no writing above it
      const essay = essayOfTable(body[essayAt].table);
      const above = promptAbove(body, essayAt, skip);
      const taskLabel = pair.taskLabel || essay.taskLabel;
      const review = reviewHeadingAfter(body, at);
      rows.push({
        tableIdx,
        rowIdx: 0,
        kind: KIND_IELTS_WRITING,
        layout: LAYOUT_PAIR,
        row: table.tableRows[0],
        qCell: body[essayAt].table.tableRows?.[0]?.tableCells?.[0] || null,
        fbCell: pair.leftCell,
        numberCell: null,
        isOverall: false,
        overallCell: null,
        task: taskLabel || guessColumnTask(above.exercise, above.imageIds),
        taskFromLabel: Boolean(taskLabel),
        promptText: above.promptText,
        imageIds: above.imageIds,
        essayText: essay.essayText,
        feedbackText: pair.feedbackText,
        insertAt: pair.leftAt,
        improvedAt: pair.rightAt,
        reviewAt: review ? review.insertAt : null,
      });
      return;
    }
    const sentences = resolveSentenceTable(table);
    if (sentences) {
      const above = sentencePromptAbove(body, at, skip);
      for (const line of sentences.rows) {
        rows.push({
          tableIdx,
          rowIdx: line.rowIdx,
          kind: KIND_IELTS_SENTENCE,
          layout: LAYOUT_SENTENCES,
          row: line.row,
          qCell: line.row.tableCells[0],
          fbCell: line.fbCell,
          numberCell: null,
          isOverall: false,
          overallCell: null,
          columns: sentences.columns,
          cells: line.cells,
          answered: line.answered,
          promptText: above.promptText,
          imageIds: above.imageIds,
          feedbackText: line.feedbackText,
          insertAt: line.insertAt,
        });
      }
      return;
    }
    const resolved = resolveIeltsTable(table);
    if (resolved?.invalid) {
      invalidTables.push(tableIdx);
      return;
    }
    if (resolved) {
      rows.push({
        tableIdx,
        rowIdx: resolved.essayRowIdx,
        kind: KIND_IELTS_WRITING,
        layout: LAYOUT_ROWS,
        row: table.tableRows[resolved.essayRowIdx],
        qCell: resolved.essayCell,
        fbCell: resolved.fbCell,
        numberCell: null,
        isOverall: false,
        overallCell: null,
        task: resolved.task,
        promptText: getCellText(resolved.promptCell),
        imageIds: imageIdsInCell(resolved.promptCell),
      });
      return;
    }
    let columns = 0;
    (table.tableRows || []).forEach((row, rowIdx) => {
      const column = resolveColumnRow(row);
      if (!column) return;
      columns++;
      const above = promptAbove(body, at, skip);
      rows.push({
        tableIdx,
        rowIdx,
        kind: KIND_IELTS_WRITING,
        layout: LAYOUT_COLUMNS,
        row,
        qCell: column.essayCell,
        fbCell: column.fbCell,
        numberCell: null,
        isOverall: false,
        overallCell: null,
        task:
          column.taskLabel || guessColumnTask(above.exercise, above.imageIds),
        taskFromLabel: Boolean(column.taskLabel),
        promptText: above.promptText,
        imageIds: above.imageIds,
        essayText: column.essayText,
        feedbackText: column.feedbackText,
        insertAt: column.insertAt,
      });
    });
    if (columns) return;
    const below = resolveBelowTable(table);
    if (!below) return;
    const above = promptAbove(body, at, skip);
    rows.push({
      tableIdx,
      rowIdx: below.rowIdx,
      kind: KIND_IELTS_WRITING,
      layout: LAYOUT_BELOW,
      row: table.tableRows[below.rowIdx],
      qCell: below.essayCell,
      fbCell: below.fbCell,
      numberCell: null,
      isOverall: false,
      overallCell: null,
      task: below.taskLabel || guessColumnTask(above.exercise, above.imageIds),
      taskFromLabel: Boolean(below.taskLabel),
      promptText: above.promptText,
      imageIds: above.imageIds,
      essayText: below.essayText,
      feedbackText: below.feedbackText,
      insertAt: below.insertAt,
    });
  });
  return { rows, invalidTables };
}

/**
 * The pieces of writing to grade: written, and "GV chữa" still empty. A cell
 * with anything in it — an earlier grading, the teacher's own notes — is
 * never written over.
 *
 * A short-sentence table is ONE item (type KIND_IELTS_SENTENCES) holding its
 * written rows whose comment cell is still empty; rows a teacher already
 * commented on are left alone, the others still graded.
 *
 * @returns {{items: Array<{question, answer, type, task, imageIds,
 *   tableIdx, rowIdx} | {question, type, columns, sentences: Array<{rowIdx,
 *   cells}>, imageIds, tableIdx, rowIdx}>, graded: number}}
 */
export function selectIeltsItemsToGrade(rows) {
  const items = [];
  let graded = 0;
  const sentenceTables = new Map();
  for (const entry of rows || []) {
    if (entry.kind === KIND_IELTS_SENTENCE) {
      if (!entry.answered) continue;
      let table = sentenceTables.get(entry.tableIdx);
      if (!table) {
        table = { graded: 0, item: null };
        sentenceTables.set(entry.tableIdx, table);
      }
      if (entry.feedbackText.trim()) {
        table.graded++;
        continue;
      }
      if (!table.item) {
        table.item = {
          question: entry.promptText,
          type: KIND_IELTS_SENTENCES,
          columns: entry.columns,
          sentences: [],
          imageIds: entry.imageIds,
          tableIdx: entry.tableIdx,
          rowIdx: entry.rowIdx,
        };
        items.push(table.item);
      }
      table.item.sentences.push({ rowIdx: entry.rowIdx, cells: entry.cells });
      continue;
    }
    if (entry.kind !== KIND_IELTS_WRITING) continue;
    // The 2-column layout: its cells start with a heading, which is neither
    // the student's writing nor anyone's feedback.
    const columns = headedLayout(entry);
    const essay = (columns ? entry.essayText : getCellText(entry.qCell)).trim();
    if (!essay) continue;
    // The template's own part labels ("Intro:", "Body 1:") are not writing.
    if (
      columns &&
      essay.split("\n").every((line) => PART_LABEL_LINE.test(line))
    ) {
      continue;
    }
    if ((columns ? entry.feedbackText : getCellText(entry.fbCell)).trim()) {
      graded++;
      continue;
    }
    items.push({
      question: entry.promptText,
      answer: essay,
      type: KIND_IELTS_WRITING,
      task: entry.task,
      imageIds: entry.imageIds,
      tableIdx: entry.tableIdx,
      rowIdx: entry.rowIdx,
    });
  }
  for (const table of sentenceTables.values()) {
    if (!table.item && table.graded) graded++;
  }
  return { items, graded };
}

// ---------------------------------------------------------------------------
// Writing and clearing the headed layouts (2 columns, row below)
// ---------------------------------------------------------------------------

export const IELTS_NAMED_RANGE_PREFIX = "aiFb:ielts:v1:";

/** FNV-1a, base 36: a short, stable fingerprint (not a security hash). */
function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Name of the named range around one inserted feedback. */
export const ieltsRangeName = (rowKey, plain) =>
  `${IELTS_NAMED_RANGE_PREFIX}${fingerprint(rowKey)}:${fingerprint(plain)}`;

const rowKeyOf = (entry) => `${entry.tableIdx}:${entry.rowIdx}`;

/**
 * The feedback as inserted below the heading: a newline (so it starts its
 * own paragraph) and the text with its "**" markers turned into bold spans.
 * Into an empty cell (a sentence's comment) it goes without the newline.
 */
function columnText(feedback, lead = "\n") {
  const bold = [];
  let plain = lead;
  const re = /\*\*(.+?)\*\*/gs;
  let last = 0;
  let m;
  const text = String(feedback ?? "");
  while ((m = re.exec(text))) {
    plain += text.slice(last, m.index);
    bold.push([plain.length, plain.length + m[1].length]);
    plain += m[1];
    last = m.index + m[0].length;
  }
  plain += text.slice(last);
  return { plain, bold };
}

/**
 * Where one result's text goes: [{key, at, text, lead}] — `key` names its
 * range. A pair table takes the corrected writing, the improved version and
 * the review in three places (each its own range); without a "NHẬN XÉT" line
 * below the table the review follows the corrected writing in the left cell.
 * A result without parts (graded before parts existed) goes whole into the
 * left cell.
 */
function piecesOf(entry, result) {
  const key = result.rowKey;
  if (entry.layout === LAYOUT_SENTENCES) {
    return [{ key, at: entry.insertAt, text: result.aiFeedback, lead: "" }];
  }
  const parts = result.parts;
  if (entry.layout !== LAYOUT_PAIR || !parts?.corrected || !parts?.improved) {
    return [{ key, at: entry.insertAt, text: result.aiFeedback, lead: "\n" }];
  }
  const review = String(parts.review ?? "").trim();
  const pieces = [
    { key: `${key}:i`, at: entry.improvedAt, text: parts.improved, lead: "\n" },
  ];
  if (review && entry.reviewAt !== null && entry.reviewAt !== undefined) {
    pieces.push({
      key: `${key}:r`,
      at: entry.reviewAt,
      text: review,
      lead: "\n",
    });
    pieces.push({
      key: `${key}:c`,
      at: entry.insertAt,
      text: parts.corrected,
      lead: "\n",
    });
  } else {
    const text = review
      ? `${parts.corrected}\n\n**${REVIEW_HEADING}**\n${review}`
      : parts.corrected;
    pieces.push({ key: `${key}:c`, at: entry.insertAt, text, lead: "\n" });
  }
  return pieces;
}

/**
 * The headed entries `gradingResults` target, with what goes where: one
 * write per range ({entry, rowKey: the range's key, at, plain, bold}).
 */
function planColumnWrites(gradingResults, rows) {
  const byKey = new Map(
    (rows || []).filter(headedLayout).map((entry) => [rowKeyOf(entry), entry]),
  );
  const writes = [];
  for (const result of gradingResults || []) {
    const entry = byKey.get(result.rowKey);
    if (!entry || !String(result.aiFeedback ?? "").trim()) continue;
    for (const piece of piecesOf(entry, result)) {
      writes.push({
        entry,
        rowKey: piece.key,
        at: piece.at,
        ...columnText(piece.text, piece.lead),
      });
    }
  }
  return writes;
}

const hasColumns = (rows) => (rows || []).some(headedLayout);
const oldLayout = (rows) =>
  (rows || []).filter((entry) => !headedLayout(entry));

/**
 * batchUpdate requests writing `gradingResults` into an IELTS tab. A tab of
 * old-layout tables only gets docWriter's requests, unchanged. Every other
 * entry gets its text below its heading(s) — a pair table in three places
 * (piecesOf), a sentence in its empty comment cell — un-bolded (headings are
 * bold) except its "**" spans, each piece inside a named range. Groups run
 * from the end of the tab backwards, so no insert moves another.
 */
export function buildIeltsFeedbackRequests(gradingResults, rows, tabId) {
  if (!hasColumns(rows)) {
    return buildFeedbackRequests(gradingResults, rows, tabId);
  }
  const groups = [];
  const old = oldLayout(rows);
  for (const result of gradingResults || []) {
    const entry = old.find((e) => rowKeyOf(e) === result.rowKey);
    const start = entry?.fbCell?.content?.[0]?.startIndex;
    if (start === undefined) continue;
    groups.push({
      start,
      requests: buildFeedbackRequests([result], old, tabId),
    });
  }
  for (const { at: index, rowKey, plain, bold } of planColumnWrites(
    gradingResults,
    rows,
  )) {
    const range = (from, to) => ({
      startIndex: index + from,
      endIndex: index + to,
      tabId,
    });
    groups.push({
      start: index,
      requests: [
        { insertText: { location: { index, tabId }, text: plain } },
        {
          updateTextStyle: {
            range: range(0, plain.length),
            textStyle: { bold: false, italic: false, underline: false },
            fields: "bold,italic,underline",
          },
        },
        ...bold.map(([from, to]) => ({
          updateTextStyle: {
            range: range(from, to),
            textStyle: { bold: true },
            fields: "bold",
          },
        })),
        {
          createNamedRange: {
            name: ieltsRangeName(rowKey, plain),
            range: range(0, plain.length),
          },
        },
      ],
    });
  }
  groups.sort((a, b) => b.start - a.start);
  return groups.flatMap((group) => group.requests);
}

/**
 * True when a cell `gradingResults` would write to already holds feedback:
 * an old-layout "GV chữa" cell with any text, a headed cell with anything
 * below its heading.
 */
export function ieltsTargetsAlreadyFilled(gradingResults, rows) {
  if (targetsAlreadyFilled(gradingResults, oldLayout(rows))) return true;
  return planColumnWrites(gradingResults, rows).some(({ entry }) =>
    entry.feedbackText.trim(),
  );
}

/** Every character of a tab by Docs index (paragraphs inside tables too). */
function tabCharsByIndex(tab) {
  const byIndex = new Map();
  const walk = (content) => {
    for (const block of content || []) {
      if (block.paragraph) {
        for (const el of block.paragraph.elements || []) {
          const text = el.textRun?.content;
          if (text === undefined) continue;
          for (let i = 0; i < text.length; i++) {
            byIndex.set(el.startIndex + i, text[i]);
          }
        }
      } else if (block.table) {
        for (const row of block.table.tableRows || []) {
          for (const cell of row.tableCells || []) walk(cell.content);
        }
      }
    }
  };
  walk(tab?.documentTab?.body?.content);
  return byIndex;
}

/**
 * This module's named ranges in a tab, each with the text it covers now and
 * whether that is still exactly what was written (its name carries the hash).
 */
function ownColumnFeedback(tab) {
  const chars = tabCharsByIndex(tab);
  const out = [];
  const named = tab?.documentTab?.namedRanges || {};
  for (const [name, group] of Object.entries(named)) {
    if (!name.startsWith(IELTS_NAMED_RANGE_PREFIX)) continue;
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
      out.push({ name, ranges, text, intact: fingerprint(text) === expected });
    }
  }
  return out;
}

/**
 * True when the doc, read back after a write, holds exactly what
 * `gradingResults` would write: docWriter's check for old-layout cells, an
 * intact named range for each headed one.
 */
export function matchesOwnIeltsFeedback(gradingResults, rows, tab) {
  if (!hasColumns(rows)) return matchesOwnFeedback(gradingResults, rows);
  const old = oldLayout(rows);
  const oldResults = (gradingResults || []).filter((r) =>
    old.some((e) => rowKeyOf(e) === r.rowKey),
  );
  if (oldResults.length && !matchesOwnFeedback(oldResults, old)) return false;
  const writes = planColumnWrites(gradingResults, rows);
  if (!writes.length) return oldResults.length > 0;
  const present = new Set(
    ownColumnFeedback(tab)
      .filter((f) => f.intact)
      .map((f) => f.name),
  );
  return writes.every(({ rowKey, plain }) =>
    present.has(ieltsRangeName(rowKey, plain)),
  );
}

/**
 * "Xóa feedback" for an IELTS tab. Old-layout tables: their "GV chữa" cells
 * are emptied, as before (docWriter). Headed tables: only the text of this
 * module's named ranges still holding exactly what was written — the heading
 * and anything a teacher typed stay; a range a teacher edited into is kept.
 *
 * @returns {{requests: object[], count: number, rows: number}} count: the
 *   cells emptied plus the feedbacks removed; rows: IELTS entries found.
 */
export function buildIeltsClearRequests(tab) {
  const tabId = tab?.tabProperties?.tabId;
  const { rows } = collectIeltsRows(tab);
  const oldRequests = buildClearFeedbackRequests(oldLayout(rows), tabId);
  const removed = ownColumnFeedback(tab).filter((f) => f.intact && f.text);
  if (!removed.length) {
    return {
      requests: oldRequests,
      count: oldRequests.length,
      rows: rows.length,
    };
  }
  const deletes = [
    ...oldRequests,
    ...removed.flatMap((f) =>
      f.ranges.map((r) => ({
        deleteContentRange: {
          range: { startIndex: r.startIndex, endIndex: r.endIndex, tabId },
        },
      })),
    ),
  ].sort(
    (a, b) =>
      b.deleteContentRange.range.startIndex -
      a.deleteContentRange.range.startIndex,
  );
  const names = [...new Set(removed.map((f) => f.name))];
  return {
    requests: [
      ...deletes,
      ...names.map((name) => ({
        deleteNamedRange: { name, tabsCriteria: { tabIds: [tabId] } },
      })),
    ],
    count: oldRequests.length + removed.length,
    rows: rows.length,
  };
}

// ---------------------------------------------------------------------------
// "Cập nhật mẫu": turning a lesson into the current template
// ---------------------------------------------------------------------------

/** An exercise the student writes in: "Viết …", "Kết hợp các câu …". */
const WRITING_EXERCISE =
  /vi[eế]t|k[eế]t\s*h[oợ]p|g[oợ]i\s*ý\s*(m[oộ]t\s*)?solutions?/iu;
/** …whose writing is an essay or a part of one, not short sentences. */
const ESSAY_EXERCISE =
  /ho[aà]n\s*ch[iỉ]nh|full\s*essay|complete\s*essay|intro|overview|m[ởo]\s*b[aà]i|k[ếe]t\s*b[aà]i|conclusion|đo[aạ]n\s*v[aă]n|paragraph/iu;
/** A cell starting with a part label: "Intro:", "Body 1: …", "Introduction". */
const PART_LABEL_START =
  /^\s*(intro(duction)?|overview|body\s*\d*|conclusion|m[ởo]\s*b[aà]i|k[ếe]t\s*b[aà]i|th[âa]n\s*b[aà]i\s*\d*)(?![\p{L}])/iu;
/**
 * A line introducing something the teacher filled in, not the student: a
 * worked example ("VD: …", "Ví dụ …"), reference vocabulary ("Gợi ý từ
 * vựng", "Từ vựng tham khảo"), a model answer ("Bài mẫu", "Câu mẫu").
 */
const EXAMPLE_LINE =
  /^\s*(vd|v[ií]\s*d[uụ]|example|g[oợ]i\s*ý|tham\s*kh[aả]o|t[uừ]\s*v[uự]ng|vocabulary|(b[aà]i|c[aâ]u)\s*m[aẫ]u)(?![\p{L}])/iu;

/**
 * True when the table at `at` is the teacher's: one of the lines between it
 * and the table or exercise line above introduces an example ("VD: Kết hợp
 * mô tả Spain …", then the example sentence, then its table).
 */
function isExampleTable(body, at) {
  for (let i = at - 1; i >= 0; i--) {
    const block = body[i];
    if (!block?.paragraph) return false;
    const text = blockText(block);
    if (EXERCISE_LINE.test(text)) return false;
    if (EXAMPLE_LINE.test(text)) return true;
  }
  return false;
}

/** A matching exercise ("Hãy nối các problems này với reasons"). */
const MATCHING_EXERCISE = /(?<![\p{L}])n[oố]i(?![\p{L}])/iu;
/** "trong bài viết sau": the text to study, not something to write. */
const ARTICLE = /b[aà]i\s*vi[eế]t/giu;

/** "essay" | "sentences" | null for an exercise line. */
export function exerciseKind(text) {
  const t = String(text ?? "")
    .normalize("NFC")
    .replace(ARTICLE, "");
  if (!WRITING_EXERCISE.test(t)) return null;
  if (ESSAY_EXERCISE.test(t)) return "essay";
  return MATCHING_EXERCISE.test(t) ? null : "sentences";
}

const blockText = (block) =>
  block?.paragraph
    ? getCellLines({ content: [block] })
        .join(" ")
        .trim()
    : "";

/** The lesson's own writing table: every row starts with a part label. */
function isEssayShaped(table) {
  const rows = table?.tableRows || [];
  if (!rows.length) return false;
  return rows.every((row) => {
    const label = rowLabel(row);
    return label !== null && PART_LABEL_START.test(label.text.normalize("NFC"));
  });
}

/**
 * Cells merged across columns, or rows short of cells: a new last column
 * would not get one plain cell per row. Cells merged down a column (buổi 13's
 * "Gợi ý" beside "Tiếng Việt:" and "Tiếng Anh:") are fine — Docs still lists
 * every cell of every row.
 */
function hasMergedCells(table) {
  return (table?.tableRows || []).some(
    (row) =>
      (row.tableCells || []).length !== table.columns ||
      (row.tableCells || []).some(
        (c) => (c.tableCellStyle?.columnSpan || 1) > 1,
      ),
  );
}

/** A first row of short titles ("Loại chủ ngữ | Câu mô tả"), not labels. */
function hasHeaderRow(table) {
  const cells = table?.tableRows?.[0]?.tableCells || [];
  if (cells.length < 2) return false;
  return cells.every((c) => {
    const text = getCellText(c).trim();
    return text !== "" && !/:\s*$/.test(text);
  });
}

/**
 * The look of the table's text — font, size, colour of its first run — so
 * the headings the converter adds match the lesson rather than whatever
 * paragraph they were typed next to.
 */
function textLookOf(table) {
  for (const row of table?.tableRows || []) {
    for (const cell of row.tableCells || []) {
      for (const block of cell.content || []) {
        for (const el of block.paragraph?.elements || []) {
          const style = el.textRun?.textStyle;
          if (!style || !el.textRun.content.trim()) continue;
          const look = {};
          for (const key of [
            "weightedFontFamily",
            "fontSize",
            "foregroundColor",
          ]) {
            if (style[key]) look[key] = style[key];
          }
          return look;
        }
      }
    }
  }
  return {};
}

/** A bold heading's style request over [start, end). */
function headingStyle(start, end, tabId, look) {
  const textStyle = { ...look, bold: true, italic: false, underline: false };
  return {
    updateTextStyle: {
      range: { startIndex: start, endIndex: end, tabId },
      textStyle,
      fields: Object.keys(textStyle).join(","),
    },
  };
}

/** A plain left-aligned, unbulleted paragraph over [start, end). */
function plainParagraph(start, end, tabId) {
  const range = { startIndex: start, endIndex: end, tabId };
  return [
    { deleteParagraphBullets: { range } },
    {
      updateParagraphStyle: {
        range,
        paragraphStyle: {
          namedStyleType: "NORMAL_TEXT",
          alignment: "START",
          indentStart: { magnitude: 0, unit: "PT" },
          indentFirstLine: { magnitude: 0, unit: "PT" },
        },
        fields: "namedStyleType,alignment,indentStart,indentFirstLine",
      },
    },
  ];
}

/**
 * Requests adding the pair table and the "NHẬN XÉT" line right below the
 * essay table that ends at `at` (the start of the paragraph after it).
 * Docs puts a new table after an empty paragraph it inserts at `at`; a fresh
 * 1×2 table spans 7 indexes: table, row, then cell + empty paragraph twice,
 * then its end — so its cells' paragraphs are at at+4 and at+6.
 */
function pairTableRequests(at, tabId, look) {
  const h1 = FEEDBACK_HEADING;
  const h2 = IMPROVED_HEADING;
  const r = REVIEW_HEADING;
  const leftAt = at + 4;
  const rightAt = at + 6 + h1.length;
  const reviewAt = at + 8 + h1.length + h2.length;
  return [
    { insertText: { location: { index: at, tabId }, text: `${r}\n` } },
    { insertTable: { rows: 1, columns: 2, location: { index: at, tabId } } },
    { insertText: { location: { index: at + 6, tabId }, text: h2 } },
    { insertText: { location: { index: at + 4, tabId }, text: h1 } },
    ...plainParagraph(at, at + 1, tabId),
    ...plainParagraph(reviewAt, reviewAt + r.length + 1, tabId),
    headingStyle(leftAt, leftAt + h1.length, tabId, look),
    headingStyle(rightAt, rightAt + h2.length, tabId, look),
    headingStyle(reviewAt, reviewAt + r.length, tabId, look),
  ];
}

/** Fixed widths of every column, or null when any is not fixed. */
function fixedWidths(table) {
  const props = table?.tableStyle?.tableColumnProperties || [];
  if (props.length !== table.columns) return null;
  const widths = props.map((p) =>
    p.widthType === "FIXED_WIDTH" && p.width?.unit === "PT"
      ? p.width.magnitude
      : null,
  );
  return widths.every((w) => typeof w === "number" && w > 0) ? widths : null;
}

const columnWidth = (tableStart, tabId, columnIndex, width) => ({
  updateTableColumnProperties: {
    tableStartLocation: { index: tableStart, tabId },
    columnIndices: [columnIndex],
    tableColumnProperties: {
      widthType: "FIXED_WIDTH",
      width: { magnitude: Math.round(width * 100) / 100, unit: "PT" },
    },
    fields: "widthType,width",
  },
});

/**
 * Requests adding the "GV chữa/nhận xét" column at the right of a sentence
 * table, and a first row of titles when it has none. A new column gives each
 * row one more cell (cell + empty paragraph: 2 indexes), placed where the
 * row ended; a new first row of n cells sits right after the table's start.
 * A column copies its neighbour's width, so fixed widths are shared out
 * again: the comment column gets about 40% of the table.
 */
function sentenceColumnRequests(block, tabId, look) {
  const { table, startIndex: s, endIndex: e } = block;
  const rows = table.tableRows;
  const n = table.columns;
  const loc = { index: s, tabId };
  const requests = [
    {
      insertTableColumn: {
        tableCellLocation: {
          tableStartLocation: loc,
          rowIndex: 0,
          columnIndex: n - 1,
        },
        insertRight: true,
      },
    },
  ];
  // Next to a cell merged down a column ("Gợi ý" beside "Tiếng Việt:" and
  // "Tiếng Anh:"), Docs merges the new cell the same way, leaving the rows
  // below without a comment cell of their own (seen on buổi 13). Split the
  // new column back into one cell per row; each already holds its own empty
  // paragraph, so no index moves.
  const mergedDown = rows.some((row) =>
    (row.tableCells || []).some((c) => (c.tableCellStyle?.rowSpan || 1) > 1),
  );
  if (mergedDown) {
    requests.push({
      unmergeTableCells: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: loc,
            rowIndex: 0,
            columnIndex: n,
          },
          rowSpan: rows.length,
          columnSpan: 1,
        },
      },
    });
  }
  if (hasHeaderRow(table)) {
    const rowEnd = rows.length > 1 ? rows[1].startIndex : e - 1;
    const at = rowEnd + 1;
    requests.push(
      {
        insertText: { location: { index: at, tabId }, text: FEEDBACK_HEADING },
      },
      headingStyle(at, at + FEEDBACK_HEADING.length, tabId, look),
    );
  } else {
    requests.push({
      insertTableRow: {
        tableCellLocation: {
          tableStartLocation: loc,
          rowIndex: 0,
          columnIndex: 0,
        },
        insertBelow: false,
      },
    });
    const firstAt = s + 3;
    const lastAt = s + 3 + 2 * n;
    const first = SENTENCE_HEADING;
    requests.push(
      {
        insertText: {
          location: { index: lastAt, tabId },
          text: FEEDBACK_HEADING,
        },
      },
      { insertText: { location: { index: firstAt, tabId }, text: first } },
      headingStyle(firstAt, firstAt + first.length, tabId, look),
      headingStyle(
        lastAt + first.length,
        lastAt + first.length + FEEDBACK_HEADING.length,
        tabId,
        look,
      ),
    );
  }
  const widths = fixedWidths(table);
  if (widths) {
    const total = widths.reduce((sum, w) => sum + w, 0);
    const comment = total * (n === 1 ? 0.45 : 0.4);
    const scale = (total - comment) / total;
    widths.forEach((w, k) =>
      requests.push(columnWidth(s, tabId, k, w * scale)),
    );
    requests.push(columnWidth(s, tabId, n, comment));
  }
  return requests;
}

/**
 * What "Cập nhật mẫu" would change in a lesson tab, and the requests doing it
 * in one batchUpdate. Exercise by exercise ("Exercise N: …" lines):
 *  - an essay exercise ("Viết Intro và Overview", "viết bài hoàn chỉnh"): its
 *    writing table — the lesson's own (every row a part label: "Intro:", …),
 *    the 2-column one or one with a "GV chữa/nhận xét" row below — gets the
 *    pair table and the "NHẬN XÉT" line below it; the older template's empty
 *    feedback row or column goes. A table whose feedback already holds text
 *    was graded: it stays as it is.
 *  - a short-sentence exercise ("Viết câu …", "Kết hợp các câu …"): each of
 *    its tables gets a "GV chữa/nhận xét" column, except a worked example
 *    (right under a "VD: …" line).
 * Anything else (fill in the gaps, multiple choice, outlines, checklists) is
 * not touched. A tab already on the template plans nothing: running it again
 * is a no-op. Groups run from the end of the tab up, so no change moves the
 * next one's indexes.
 *
 * @returns {{changes: Array<{exercise, kind, tableIdx, written}>,
 *   skipped: Array<{exercise, reason}>, requests: object[]}}
 *   reason: "graded" | "noTable" | "merged" | "layout".
 */
export function planIeltsTemplateUpdate(tab) {
  const tabId = tab?.tabProperties?.tabId;
  const body = tab?.documentTab?.body?.content || [];
  const changes = [];
  const skipped = [];
  const groups = [];
  const tableIdxAt = new Map();
  body.forEach((block, at) => {
    if (block?.table) tableIdxAt.set(at, tableIdxAt.size);
  });

  // Exercises in document order: [{text, kind, from, to}].
  const exercises = [];
  body.forEach((block, at) => {
    const text = blockText(block);
    if (!EXERCISE_LINE.test(text)) return;
    if (exercises.length) exercises.at(-1).to = at;
    exercises.push({
      text,
      kind: exerciseKind(text),
      from: at + 1,
      to: body.length,
    });
  });

  for (const exercise of exercises) {
    if (!exercise.kind) continue;
    const tables = [];
    for (let at = exercise.from; at < exercise.to; at++) {
      if (body[at]?.table) tables.push(at);
    }
    const name = exercise.text;
    if (exercise.kind === "sentences") {
      let found = 0;
      for (const at of tables) {
        const block = body[at];
        if (resolveSentenceTable(block.table)) {
          found++;
          continue; // already on the template
        }
        if (isExampleTable(body, at)) continue;
        if (isWritingTable(block.table)) continue; // an essay layout
        found++;
        if (hasMergedCells(block.table)) {
          skipped.push({ exercise: name, reason: "merged" });
          continue;
        }
        const textsOf = (row) =>
          (row.tableCells || []).map((c) => getCellText(c));
        const headed = hasHeaderRow(block.table);
        const titles = headed ? textsOf(block.table.tableRows[0]) : [];
        const written = block.table.tableRows
          .slice(headed ? 1 : 0)
          .some((row) => sentenceWritten(textsOf(row), titles));
        changes.push({
          exercise: name,
          kind: "sentences",
          tableIdx: tableIdxAt.get(at),
          written,
        });
        groups.push({
          start: block.startIndex,
          requests: sentenceColumnRequests(
            block,
            tabId,
            textLookOf(block.table),
          ),
        });
      }
      if (!found) skipped.push({ exercise: name, reason: "noTable" });
      continue;
    }

    let found = 0;
    for (const at of tables) {
      const block = body[at];
      const table = block.table;
      if (resolvePairTable(table)) {
        found++;
        continue; // already on the template (seen from its essay table)
      }
      const next = nextBlockAt(body, at);
      if (
        next >= 0 &&
        body[next]?.table &&
        resolvePairTable(body[next].table)
      ) {
        continue; // the essay table of a pair already in place
      }
      const columnRow = (table.tableRows || []).findIndex((row) =>
        resolveColumnRow(row),
      );
      const below = columnRow < 0 ? resolveBelowTable(table) : null;
      if (columnRow < 0 && !below && !isEssayShaped(table)) continue;
      found++;
      const after = body[at + 1];
      if (!after?.paragraph || after.startIndex !== block.endIndex) {
        skipped.push({ exercise: name, reason: "layout" });
        continue;
      }
      const look = textLookOf(table);
      const requests = pairTableRequests(block.endIndex, tabId, look);
      const loc = { index: block.startIndex, tabId };
      if (columnRow >= 0) {
        const column = resolveColumnRow(table.tableRows[columnRow]);
        if (column.feedbackText.trim()) {
          skipped.push({ exercise: name, reason: "graded" });
          continue;
        }
        const fbCol = table.tableRows[columnRow].tableCells.indexOf(
          column.fbCell,
        );
        if (table.rows !== 1 || table.columns !== 2 || fbCol !== 1) {
          skipped.push({ exercise: name, reason: "layout" });
          continue;
        }
        const widths = fixedWidths(table);
        requests.push({
          deleteTableColumn: {
            tableCellLocation: {
              tableStartLocation: loc,
              rowIndex: 0,
              columnIndex: 1,
            },
          },
        });
        if (widths) {
          requests.push(
            columnWidth(block.startIndex, tabId, 0, widths[0] + widths[1]),
          );
        }
      } else if (below) {
        if (below.feedbackText.trim()) {
          skipped.push({ exercise: name, reason: "graded" });
          continue;
        }
        if (below.rowIdx !== table.rows - 1) {
          skipped.push({ exercise: name, reason: "layout" });
          continue;
        }
        requests.push({
          deleteTableRow: {
            tableCellLocation: {
              tableStartLocation: loc,
              rowIndex: below.rowIdx,
              columnIndex: 0,
            },
          },
        });
      }
      const written = essayOfTable(table)
        .essayText.split("\n")
        .some((line) => line.trim() && !PART_LABEL_LINE.test(line));
      changes.push({
        exercise: name,
        kind: "essay",
        tableIdx: tableIdxAt.get(at),
        written,
      });
      groups.push({ start: block.startIndex, requests });
    }
    if (!found) skipped.push({ exercise: name, reason: "noTable" });
  }

  groups.sort((a, b) => b.start - a.start);
  return { changes, skipped, requests: groups.flatMap((g) => g.requests) };
}
