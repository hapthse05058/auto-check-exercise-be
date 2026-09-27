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
 * Pure. The backend copies this file verbatim into
 * auto-check-exercise-be/backend/lib/doc/ — see the header of docWriter.js.
 */
import { getCellText } from "./docParser.js";

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
  const ids = [];
  for (const block of cell?.content || []) {
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

/** The temporary download URL of one image of the tab, or null. */
export function imageUri(tab, objectId) {
  const doc = tab?.documentTab || {};
  const embedded =
    doc.inlineObjects?.[objectId]?.inlineObjectProperties?.embeddedObject ||
    doc.positionedObjects?.[objectId]?.positionedObjectProperties
      ?.embeddedObject;
  return embedded?.imageProperties?.contentUri || null;
}

/**
 * Every IELTS Writing table of a tab, as row entries (see the file header).
 *
 * @returns {{rows: object[], invalidTables: number[]}}
 */
export function collectIeltsRows(tab) {
  const rows = [];
  const invalidTables = [];
  for (const { tableIdx, table } of listTables(tab)) {
    const resolved = resolveIeltsTable(table);
    if (!resolved) continue;
    if (resolved.invalid) {
      invalidTables.push(tableIdx);
      continue;
    }
    rows.push({
      tableIdx,
      rowIdx: resolved.essayRowIdx,
      kind: KIND_IELTS_WRITING,
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
  }
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
    const essay = getCellText(entry.qCell).trim();
    if (!essay) continue;
    if (getCellText(entry.fbCell).trim()) {
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
