/**
 * Pure parsing helpers for extracting question/answer pairs from a Google Doc
 * tab.
 *
 * The exercise table is filled in by students, so the layout it is supposed to
 * follow ("N." for the question, "→" for the answer) is routinely broken: a
 * different arrow, no arrow at all, the answer typed on the next line, bold or
 * highlighted text splitting a line into several runs. Everything here is
 * built to still read the pair out of such a cell — and, when it genuinely
 * cannot, to say so (see `getUnreadableQuestions`) rather than guess.
 *
 * Pure. The backend copies this file verbatim into
 * auto-check-exercise-be/backend/lib/doc/ to run grading jobs — see the header
 * of docWriter.js.
 */

export const IS_CORRECT_ANSWER = "✅ Đúng";

/**
 * What a paragraph ("Học viên viết") with no mistake gets, in place of
 * "✅ Đúng" — the wording the teachers asked for.
 */
export const PARAGRAPH_ALL_CORRECT = "Các câu đúng hết rồi nha! ^^";

/** Buổi 15/16/17 grade two forms in one cell ("Câu đơn: ✅ Đúng Câu phức…"). */
const DUAL_SENTENCE_FEEDBACK = /Câu (đơn|phức)/i;

/**
 * True when a feedback says the item is right. The one test for it, so the
 * cell writer and the overall comment always agree: "✅ Đúng" (also with
 * stray text around it, which the writer collapses), or the paragraph's
 * all-correct sentence — but not a Câu đơn/phức cell where only one form is
 * right.
 */
export function isCorrectFeedback(feedback) {
  const text = String(feedback ?? "").trim();
  if (!text) return false;
  if (text === PARAGRAPH_ALL_CORRECT) return true;
  return text.includes(IS_CORRECT_ANSWER) && !DUAL_SENTENCE_FEEDBACK.test(text);
}

/**
 * The one literal marker in the layout: the row holding the teacher's overall
 * comment. Lives here rather than in `docWriter` because the table detector
 * needs it too, and `docWriter` imports from this module — putting it the
 * other way round would close an import cycle.
 */
export const OVERALL_FEEDBACK_LABEL = "Nhận xét chung của Giáo viên";

/**
 * Loại bài "Bài tập viết đoạn văn": cả bảng là MỘT item — đề là chủ đề + đoạn
 * văn mẫu, câu trả lời là cả đoạn học viên viết. Khai báo ở đây chứ không ở
 * `docTableDetect` vì parser cần nó, và `docTableDetect` import từ module này —
 * đặt ngược lại sẽ khép vòng import (cùng lý do với OVERALL_FEEDBACK_LABEL).
 */
export const KIND_PARAGRAPH = "paragraph";

/**
 * Số thứ tự mở đầu một câu hỏi. Cho phép khoảng trắng đứng trước và chấp nhận
 * cả "1)" / "1 ." vì học sinh hay gõ lệch. Nhóm capture chỉ chứa CHỮ SỐ, để
 * `extractQuestionIndex` và `docWriter` luôn so khớp trên cùng một giá trị.
 */
const QUESTION_NUMBER = /^\s*(\d{1,3})\s*[.)]/;

/**
 * Mọi biến thể dấu mũi tên / nhãn học sinh hay gõ thay cho "→".
 * `[-–—=]` bao cả gạch ngang dài (en-dash "–", em-dash "—") do Google Docs tự
 * autocorrect "-" thành "–", tạo ra "–>" thay vì "->". `\s*` ở cuối cho phép gõ
 * dính liền: "->I don't know".
 */
const ARROW = /[→⇒⟹⟶➔➜➞➡↦↔⇄»]+|[-–—=]{1,3}>{1,3}|>{1,2}/;
const ANSWER_LABEL =
  /(?:ans(?:wer)?|tl|tr[ảa]\s*l[ờo]i|đ[áa]p\s*[áa]n)\s*[:.\-–—]|:/;
const ANSWER_MARKER = new RegExp(
  `^\\s*(?:${ARROW.source}|${ANSWER_LABEL.source})\\s*`,
  "i",
);
// Bản dùng để XOÁ marker trước khi kiểm tra "ô này có chữ không". Neo đầu dòng
// (cờ `m`) nên không bao giờ đụng tới dấu ">" nằm giữa câu ("x > 2").
const ANSWER_MARKER_LINE_START = new RegExp(ANSWER_MARKER.source, "gim");

/**
 * Ký tự chỉ có trong tiếng Việt ⇒ dòng đó là đề bài, không phải câu trả lời
 * tiếng Anh. Cờ `i` phủ luôn chữ hoa nên không cần liệt kê Ă/Â/Đ/Ê/Ô/Ơ/Ư…
 */
const VIETNAMESE_CHARS =
  /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụỳýỷỹỵ]/i;

// Dòng "đề bài phụ" của buổi 15/16/17/22 — vẫn thuộc câu hỏi.
const QUESTION_LABEL = /^\s*câu\s+(đơn|phức|ghép)/i;
// Đề bài "ra lệnh" rồi mới đưa câu tiếng Anh xuống dòng dưới ⇒ dòng NGAY SAU
// vẫn là đề bài, dù viết bằng tiếng gì. (buổi 23: "Rút gọn DCN trong câu sau:")
const PROMPT_CONTINUES = /:\s*$/;
// Neo vào ĐẦU dòng (ngay sau số thứ tự) vì câu ra lệnh luôn mở đầu bằng động
// từ — nếu không, một câu tiếng Việt bình thường cần dịch ("3. Tôi đã sửa xe
// hôm qua.") sẽ bị nhận nhầm là câu ra lệnh và nuốt mất dòng trả lời sau nó.
// KHÔNG dùng `\b`: trong JS `\b` là ASCII, chữ có dấu (đ, ú, ề…) bị coi là
// "non-word" nên `\bđiền` sẽ khớp sai hoàn toàn.
const PROMPT_INSTRUCTION =
  /^\s*(?:\d{1,3}\s*[.)]\s*)?(?:rút gọn|viết lại|chuyển|kết hợp|nối|sửa|điền|hoàn thành|sử dụng|dùng|đặt câu|dịch)/i;

export function startsWithNumberDot(sentence) {
  return QUESTION_NUMBER.test(String(sentence ?? ""));
}

/** True khi dòng mở đầu bằng BẤT KỲ dấu hiệu trả lời nào (→, ->, "Trả lời:"…). */
export function startsWithArrow(sentence) {
  return ANSWER_MARKER.test(String(sentence ?? ""));
}

/**
 * Dòng này là câu LỆNH tiếng Việt ⇒ dòng ngay sau nó vẫn thuộc đề bài.
 * Bắt buộc có ký tự tiếng Việt: nếu không, một câu trả lời tiếng Anh của học
 * sinh ("Use a smartphone to…", "Rewrite the sentence…") có thể bị nuốt nhầm
 * vào đề bài. Mọi từ khoá trong PROMPT_INSTRUCTION đều có dấu nên đây là lớp
 * bọc lót thứ hai, phòng khi sau này thêm từ khoá không dấu.
 */
export function isPromptInstruction(line) {
  const str = String(line ?? "");
  return VIETNAMESE_CHARS.test(str) && PROMPT_INSTRUCTION.test(str);
}

export function containsCorrectMark(str) {
  return str.includes(IS_CORRECT_ANSWER);
}

/** Normalizes a string for keying: collapse whitespace + trim. */
export function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable key uniquely identifying a graded item by its (question, answer)
 * pair. Two students who answered the SAME question DIFFERENTLY get different
 * keys, so they never share feedback.
 */
export function makeAnswerKey(question, answer, type, section) {
  const base = `${normalizeText(question)}${normalizeText(answer)}`;
  // Cùng một câu tiếng Anh có thể vừa là ĐÁP ÁN của bài dịch, vừa là ĐỀ BÀI của
  // bài chuyển sang bị động. Không tách theo loại thì hai thứ đó dùng chung
  // feedback của nhau. Bỏ hậu tố cho "vi_en" để khoá của bài dịch — tức gần như
  // toàn bộ kho câu hiện có — giữ nguyên từng byte.
  const typed = type && type !== "vi_en" ? `${base}${type}` : base;
  // A section heading ("Be going to: …") changes the right answer too; no
  // heading, no suffix, so every key without one stays as it was.
  const sec = normalizeText(section);
  return sec ? `${typed}sec:${sec}` : typed;
}

/**
 * Extracts the leading question index (e.g. "13" from "13. Bài tập...").
 * This index locates the correct row inside a student's own doc. Returns null
 * when the question has no leading number (then we must not guess a row).
 */
export function extractQuestionIndex(question) {
  const match = String(question ?? "").match(QUESTION_NUMBER);
  return match ? match[1] : null;
}

/** True when the answer cell contains anything besides markers/whitespace. */
export function hasAnswer(val) {
  if (val === null || val === undefined) {
    return false;
  }
  const str = String(val);
  if (str === "") {
    return false;
  }
  // Strip the marker at the START of each line ("→", "->", "Trả lời:"…), then
  // look for real content. Anchoring per line keeps a ">" inside the answer
  // itself ("x > 2") intact.
  return /\S/.test(str.replace(ANSWER_MARKER_LINE_START, " "));
}

/**
 * Parses pasted Google Doc URLs (one per line) into {docId, tabId} refs.
 * (Fixes an extension bug: a link without `tab=` no longer throws.)
 */
export function parseDocLinks(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const docObjects = [];

  lines.forEach((link) => {
    // The ID sits between /d/ and the next slash.
    const docIdMatch = link.match(/\/d\/(.+?)\//);
    // The tab ID follows `tab=` when present.
    const tabIdMatch = link.match(/tab=(.+?)(&|$)/);

    if (docIdMatch) {
      docObjects.push({
        docId: docIdMatch[1],
        tabId: tabIdMatch ? tabIdMatch[1] : "t.0", // default to first tab
      });
    }
  });

  return docObjects;
}

/** Recursively finds a tab (or child tab) by its title. */
export function findTabByTitle(tabs, title) {
  for (const tab of tabs) {
    if (tab.tabProperties.title === title) return tab;
    if (tab.childTabs) {
      const found = findTabByTitle(tab.childTabs, title);
      if (found) return found;
    }
  }
  return null;
}

/** Collects the rows of the exercise tables referenced by `tableIndex`. */
export function getTablesWhichContainStudentExercise(targetTab, tableIndex) {
  if (!tableIndex) return;
  const tables = (targetTab.documentTab.body?.content || []).flatMap(
    (block) => block.table || [],
  );
  const exercisePart4 = [];
  tableIndex.forEach((index) => {
    // A doc missing a table must not blow up the whole student's grading.
    exercisePart4.push(...(tables[index]?.tableRows || []));
  });
  return exercisePart4;
}

/**
 * Flattens one table cell into its non-empty text lines.
 *
 * Joins EVERY text run of every paragraph, so bold/highlight/link — which make
 * Google Docs split a line into several runs — can no longer hide the answer
 * marker. Never throws on an empty paragraph or on a cell entry that is not a
 * paragraph (nested table, section break).
 */
export function getCellLines(cell) {
  return (cell?.content || [])
    .flatMap((entry) =>
      (entry?.paragraph?.elements || [])
        .map(
          (el) =>
            el?.textRun?.content ??
            // smart chips carry their text outside of textRun
            el?.richLink?.richLinkProperties?.title ??
            el?.person?.personProperties?.name ??
            "",
        )
        .join("")
        // \v (U+000B) is the soft line break Google Docs writes for Shift+Enter.
        .split(/\r?\n|\v/),
    )
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
}

/** One cell flattened to text. Same source as `getCellLines`, so both agree. */
export function getCellText(cell) {
  return getCellLines(cell).join("\n");
}

/**
 * Một ô chỉ chứa số thứ tự ("1", "1.", "2)") — cột STT của layout cũ, không
 * phải ô đề bài. Khác `QUESTION_NUMBER` ở chỗ dấu chấm là TÙY CHỌN nhưng phải
 * hết chuỗi: "1. Tôi học tiếng Anh" không khớp, "1." thì khớp.
 */
const ONLY_QUESTION_NUMBER = /^\s*(\d{1,3})\s*[.)]?\s*$/;

/**
 * Tìm ô nào của MỘT DÒNG giữ đề bài, ô nào nhận feedback.
 *
 * Phải dò theo NỘI DUNG chứ không theo vị trí cố định, vì chỉ số ô thay đổi
 * ngay trong cùng một bảng:
 *   - bảng cũ 3 cột      → đề bài ở ô 0
 *   - bảng "BÀI TẬP VIẾT CÂU" 4 cột (Thì | Tiếng Việt → Tiếng Anh | Gợi ý |
 *     GV sửa) → đề bài ở ô 1
 *   - và cột "Thì" bị GỘP DỌC: những dòng bị gộp đè có thể được Google Docs
 *     trả về dưới dạng ô giữ chỗ rỗng (đề bài vẫn ở ô 1) HOẶC bị lược bỏ hẳn
 *     (đề bài tụt về ô 0). Quét theo nội dung nên đúng ở cả hai trường hợp,
 *     không cần biết API chọn kiểu nào.
 *
 * Ô feedback LUÔN là ô cuối ("Chữa bài" của bảng cũ, "GV sửa" của bảng mới).
 *
 * @returns {{qIndex, qCell, numberIndex, numberCell, fbIndex, fbCell}|null}
 *   null khi dòng này không phải dòng câu hỏi (dòng header, dòng công thức
 *   "B1:/B2:", dòng ví dụ…) — đây chính là thứ giữ cho các dòng đó không bao
 *   giờ bị chấm và không bao giờ bị ghi đè.
 */
export function resolveRowCells(row) {
  const cells = row?.tableCells || [];
  // Một ô thì không thể vừa là đề vừa là chỗ ghi feedback.
  if (cells.length < 2) return null;

  const fbIndex = cells.length - 1;
  let qIndex = -1;
  let numberIndex = -1;

  for (let i = 0; i < fbIndex; i++) {
    const lines = getCellLines(cells[i]);
    const text = lines.join("\n").trim();
    // Cột STT riêng: nhớ lại rồi đi tiếp, đề bài nằm ở ô sau nó.
    if (ONLY_QUESTION_NUMBER.test(text)) {
      if (numberIndex === -1) numberIndex = i;
      continue;
    }
    if (startsWithNumberDot(lines[0])) {
      qIndex = i;
      break;
    }
  }

  // Layout cũ "| 1 | đề bài | Chữa bài |": đề bài không tự mang số thứ tự, lấy
  // ô có chữ đầu tiên sau cột STT.
  if (qIndex === -1 && numberIndex !== -1) {
    for (let i = numberIndex + 1; i < fbIndex; i++) {
      if (getCellText(cells[i]).trim()) {
        qIndex = i;
        break;
      }
    }
  }

  if (qIndex === -1) return null;

  return {
    qIndex,
    qCell: cells[qIndex],
    numberIndex,
    numberCell: numberIndex === -1 ? null : cells[numberIndex],
    fbIndex,
    fbCell: cells[fbIndex],
  };
}

/**
 * Turns one cell's lines into question/answer pairs.
 *
 * Classifies each line from the most reliable signal to the most speculative,
 * so a prompt line is never mistaken for the student's answer:
 *   1. leading number   → question (starts a new pair)
 *   2. answer marker    → answer   (wins over every language rule below, so an
 *                                   answer written in Vietnamese still counts)
 *   3. "Câu phức:" label→ question
 *   4. previous line gives an order (ends with ":" or holds a Vietnamese
 *      instruction verb) → question, whatever language THIS line is in. This is
 *      what keeps "I don't know where I should live." — the English sentence a
 *      buổi 23 question asks the student to reduce — out of the answer.
 *   5. language: Vietnamese is the prompt, anything else is the answer. Only
 *      reached when nothing above decided; marks the pair `guessed`.
 *
 * @returns {Array<{question: string, answer: string, guessed: boolean}>}
 */
function buildQnaPairs(lines) {
  const pairs = [];
  let current = null;
  let inAnswer = false;
  let previousLine = "";

  const startPair = () => {
    current = { questionLines: [], answerLines: [], guessed: false };
    pairs.push(current);
  };

  for (const line of lines) {
    const previous = previousLine;
    previousLine = line;

    if (startsWithNumberDot(line)) {
      // A new numbered line only starts a new pair once the current one is
      // complete; buổi 15/16/17/22 keep "câu đơn" + "câu phức" in one pair.
      if (!current || current.answerLines.length) startPair();
      current.questionLines.push(line);
      inAnswer = false;
      continue;
    }
    // Lines before the first numbered one are section headers ("TTQH: Where").
    if (!current) continue;

    if (startsWithArrow(line)) {
      current.answerLines.push(line);
      inAnswer = true;
      continue;
    }
    if (QUESTION_LABEL.test(line)) {
      current.questionLines.push(line);
      inAnswer = false;
      continue;
    }
    if (PROMPT_CONTINUES.test(previous) || isPromptInstruction(previous)) {
      current.questionLines.push(line);
      continue;
    }
    if (VIETNAMESE_CHARS.test(line)) {
      current.questionLines.push(line);
    } else {
      current.answerLines.push(line);
    }
    // Outside answer mode we had no marker to lean on — flag the guess so the
    // teacher can be warned when it did not produce a usable answer.
    if (!inAnswer) current.guessed = true;
  }

  return pairs.map(({ questionLines, answerLines, guessed }) => ({
    question: questionLines.join("\n"),
    answer: answerLines.join("\n"),
    guessed,
  }));
}

/**
 * Đọc cặp đề bài / câu trả lời của từng dòng bài tập.
 *
 * Nhận các entry đã được `collectExerciseRows` giải sẵn, nên không còn phải
 * đoán "bỏ 2 dòng đầu là header" hay "đề bài luôn ở ô 0" — hai giả định đã vỡ
 * ngay khi tài liệu thêm bảng 4 cột có cột "Thì" gộp dọc.
 *
 * Mỗi cặp mang theo danh tính dòng (`tableIdx`/`rowIdx`) để lúc ghi feedback
 * ngược lại doc không phải dò theo số thứ tự — số thứ tự ĐƯỢC PHÉP trùng nhau
 * (bảng dạng 1 đánh số lại từ 1 ở mỗi nhóm thì).
 */
function extractPairsFromRows(rows) {
  const pairs = [];
  for (const entry of rows || []) {
    if (entry.isOverall) continue;
    // Đoạn văn không có số thứ tự hay "→": cả ô học viên viết là câu trả lời,
    // nên không được đưa qua buildQnaPairs (nó sẽ bỏ hết vì thiếu "N.").
    if (entry.kind === KIND_PARAGRAPH) {
      pairs.push({
        question: entry.promptText || "",
        answer: getCellText(entry.qCell),
        guessed: false,
        type: entry.kind,
        tableIdx: entry.tableIdx,
        rowIdx: entry.rowIdx,
      });
      continue;
    }
    for (const pair of buildQnaPairs(getCellLines(entry.qCell))) {
      pairs.push({
        ...pair,
        type: entry.kind,
        ...(entry.section ? { section: entry.section } : {}),
        tableIdx: entry.tableIdx,
        rowIdx: entry.rowIdx,
      });
    }
  }
  return pairs;
}

/**
 * Mọi cặp đã được học sinh trả lời trong một tab.
 *
 * Chỉ `{question, answer}` được gửi cho AI (nguyên văn); `type` chọn cách AI
 * được hỏi, còn `tableIdx`/`rowIdx` chỉ dùng nội bộ để ghi ngược vào doc.
 * Cột "Gợi ý từ vựng" KHÔNG bao giờ có mặt ở đây — nó nằm ở ô khác `qCell`.
 */
export function getQuesAndAnsFromRows(rows) {
  const finalArr = [];
  extractPairsFromRows(rows).forEach(
    ({ question, answer, type, section, tableIdx, rowIdx }) => {
      if (hasAnswer(answer?.trim())) {
        finalArr.push({
          question,
          answer,
          type,
          ...(section ? { section } : {}),
          tableIdx,
          rowIdx,
        });
      }
    },
  );
  return finalArr;
}

/**
 * Những câu mà parser phải đoán và vẫn không ra được câu trả lời — ví dụ học
 * sinh xoá mất "→" VÀ trả lời bằng tiếng Việt. Báo cho giáo viên tự kiểm tra
 * thay vì âm thầm bỏ dòng đó.
 *
 * Kèm `tableIdx` vì số thứ tự có thể trùng giữa các bảng: "câu 1, 2, 1, 2"
 * không nói lên điều gì, "bảng 3 câu 1" thì có.
 */
export function getUnreadableQuestions(rows) {
  return extractPairsFromRows(rows)
    .filter(({ answer, guessed }) => guessed && !hasAnswer(answer?.trim()))
    .map(({ question, tableIdx }) => ({
      tableIdx,
      questionIndex: extractQuestionIndex(question),
    }))
    .filter((item) => item.questionIndex !== null);
}

/**
 * Tình trạng chấm của một tab, tách theo từng bảng.
 *
 * `reviewed` giữ NGUYÊN ngữ nghĩa cũ (chỉ cần một dòng có feedback là cả doc bị
 * coi như đã chấm và bị bỏ qua). Hai tập còn lại chỉ để BÁO CHO ĐÚNG: khi tài
 * liệu đã chấm bài cũ nhưng vẫn còn bảng bài mới trống, giáo viên cần nghe
 * "doc bị bỏ qua vì có feedback cũ", chứ không phải "tất cả đã được chấm".
 *
 * Đoạn văn KHÔNG tham gia vào `reviewed` mà được xét THEO TỪNG Ô, trong
 * `paragraphRowKeys`: nếu không, mọi doc đã auto-chấm câu từ trước khi có loại
 * bài này sẽ không bao giờ được chấm đoạn văn, và một đoạn văn giáo viên tự
 * sửa tay sẽ làm cả doc bị bỏ qua.
 */
export function describeGradedState(rows) {
  const gradedTables = new Set();
  const ungradedTables = new Set();
  const paragraphRowKeys = { graded: new Set(), pending: new Set() };

  for (const entry of rows || []) {
    if (entry.isOverall) continue;
    if (entry.kind === KIND_PARAGRAPH) {
      const rowKey = `${entry.tableIdx}:${entry.rowIdx}`;
      if (getCellText(entry.fbCell).trim()) {
        paragraphRowKeys.graded.add(rowKey);
      } else if (hasAnswer(getCellText(entry.qCell).trim())) {
        paragraphRowKeys.pending.add(rowKey);
      }
      continue;
    }
    if (getCellText(entry.fbCell).trim()) {
      gradedTables.add(entry.tableIdx);
      continue;
    }
    const answered = buildQnaPairs(getCellLines(entry.qCell)).some(
      ({ answer }) => hasAnswer(answer?.trim()),
    );
    if (answered) ungradedTables.add(entry.tableIdx);
  }

  return {
    reviewed: gradedTables.size > 0,
    gradedTables,
    ungradedTables,
    paragraphRowKeys,
  };
}

/**
 * Những item THỰC SỰ cần chấm trong một tab — `getQuesAndAnsFromRows` đã lọc
 * theo trạng thái đã chấm.
 *
 *   - Bài câu (dịch, bị động…) giữ nguyên quy tắc cấp doc: chỉ cần một ô
 *     feedback của chúng có chữ là bỏ hết (`reviewed`).
 *   - Đoạn văn xét theo ô của chính nó: ô GV sửa còn trống thì chấm, kể cả khi
 *     các bài câu đã được chấm từ trước; đã có chữ thì không bao giờ ghi đè.
 */
export function selectItemsToGrade(rows) {
  const { reviewed, paragraphRowKeys } = describeGradedState(rows);
  return getQuesAndAnsFromRows(rows).filter((item) =>
    item.type === KIND_PARAGRAPH
      ? paragraphRowKeys.pending.has(`${item.tableIdx}:${item.rowIdx}`)
      : !reviewed,
  );
}

/**
 * True khi cột "Chữa bài"/"GV sửa" đã có feedback ở ít nhất một câu đã trả lời
 * (tài liệu từng được chấm trước đó).
 */
export function wasExerciseReviewedByAI(rows) {
  return describeGradedState(rows).reviewed;
}
