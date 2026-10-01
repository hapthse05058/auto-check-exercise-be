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
 * In both, the prompt and chart are the paragraphs right ABOVE the table (after the
 * "Exercise N" line). The task is the heading's "(Task 1)", "(Task 2)" or
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
/** Layouts whose feedback goes below a heading, in a named range. */
const headedLayout = (entry) =>
  entry?.layout === LAYOUT_COLUMNS || entry?.layout === LAYOUT_BELOW;

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

/** A table the student writes in: any IELTS layout. */
const isWritingTable = (table) =>
  resolveIeltsTable(table) !== null ||
  (table?.tableRows || []).some((row) => resolveColumnRow(row)) ||
  resolveBelowTable(table) !== null;

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
function promptAbove(body, tableAt) {
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
  let blocks = body.slice(start, tableAt).filter((b) => b?.paragraph);
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
 * Every IELTS Writing table of a tab, as row entries (see the file header).
 *
 * @returns {{rows: object[], invalidTables: number[]}}
 */
export function collectIeltsRows(tab) {
  const rows = [];
  const invalidTables = [];
  const body = tab?.documentTab?.body?.content || [];
  let tableIdx = -1;
  body.forEach((block, at) => {
    const table = block?.table;
    if (!table) return;
    tableIdx++;
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
      const above = promptAbove(body, at);
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
    const above = promptAbove(body, at);
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
 * @returns {{items: Array<{question, answer, type, task, imageIds,
 *   tableIdx, rowIdx}>, graded: number}}
 */
export function selectIeltsItemsToGrade(rows) {
  const items = [];
  let graded = 0;
  for (const entry of rows || []) {
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
 */
function columnText(feedback) {
  const bold = [];
  let plain = "\n";
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

/** The headed entries `gradingResults` target, with what goes into each. */
function planColumnWrites(gradingResults, rows) {
  const byKey = new Map(
    (rows || []).filter(headedLayout).map((entry) => [rowKeyOf(entry), entry]),
  );
  const writes = [];
  for (const result of gradingResults || []) {
    const entry = byKey.get(result.rowKey);
    if (!entry || !String(result.aiFeedback ?? "").trim()) continue;
    writes.push({
      entry,
      rowKey: result.rowKey,
      ...columnText(result.aiFeedback),
    });
  }
  return writes;
}

const hasColumns = (rows) => (rows || []).some(headedLayout);
const oldLayout = (rows) =>
  (rows || []).filter((entry) => !headedLayout(entry));

/**
 * batchUpdate requests writing `gradingResults` into an IELTS tab. A tab of
 * old-layout tables only gets docWriter's requests, unchanged. A headed (2-column,
 * row-below) entry gets its feedback below the "GV chữa/nhận xét" heading, un-bolded
 * (the heading is bold) except its "**" spans, inside a named range. Groups
 * run from the end of the tab backwards, so no insert moves another.
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
  for (const { entry, rowKey, plain, bold } of planColumnWrites(
    gradingResults,
    rows,
  )) {
    const index = entry.insertAt;
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
