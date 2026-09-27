/**
 * Nhận diện bảng bài tập trong một tab "BUỔI XX" bằng NỘI DUNG header, thay cho
 * danh sách chỉ số cứng của `docTables.js`.
 *
 * Vì sao phải đổi: chỉ số cứng ("BUỔI 04 → bảng 5,6,7,8,9") lệch ngay khi tài
 * liệu chèn thêm một bảng. Đợt bổ sung "III. BÀI TẬP VIẾT CÂU" cho buổi 04→10
 * làm đúng chuyện đó, và sẽ còn lặp lại mỗi lần giáo trình đổi.
 *
 * BẤT BIẾN CHỊU TẢI của cả module: phân loại ở CẤP BẢNG chỉ dùng để khoanh
 * vùng và gắn nhãn loại bài; quyết định "dòng này có được chấm không" nằm ở
 * CẤP DÒNG, do `resolveRowCells` trả lời. Nhờ vậy những dòng không phải câu hỏi
 * — dòng header, dòng ví dụ, dòng công thức "B1:/B2:" mà học viên tự điền —
 * không bao giờ sinh cặp Q/A và không bao giờ bị ghi đè, bất kể chúng nằm
 * trong bảng riêng hay ngay trong bảng câu hỏi.
 *
 * Pure. The backend copies this file verbatim into
 * auto-check-exercise-be/backend/lib/doc/ to run grading jobs — see the header
 * of docWriter.js.
 */
import {
  KIND_PARAGRAPH,
  OVERALL_FEEDBACK_LABEL,
  getCellText,
  getQuesAndAnsFromRows,
  normalizeText,
  resolveRowCells,
} from "./docParser.js";
import { TABLE_OVERRIDES } from "./docTables.js";

/** Dịch câu tiếng Việt sang tiếng Anh — bài tập "cũ" và bài mới buổi 04/05/06. */
export const KIND_VI_EN = "vi_en";
/** Chuyển câu tiếng Anh chủ động sang bị động — bài mới buổi 07/08/09/10. */
export const KIND_ACTIVE_PASSIVE = "active_passive";
/** "Bài tập viết đoạn văn: <chủ đề>" — buổi 02 → 23. */
export { KIND_PARAGRAPH };

/**
 * Cột feedback. Đây là tín hiệu CHÍNH để nhận ra một bảng có chấm được hay
 * không, cố ý chọn thay vì "Đề bài": nó phủ cả tên cũ ("Chữa bài") lẫn tên mới
 * ("GV sửa").
 *
 * Chỉ khớp tới chữ "chữa", KHÔNG đòi "chữa bài": template buổi 14 — cả ba đời
 * template đang lưu hành — gõ nhầm thành "Chữa phải", và một chữ sai trong
 * header đã đủ làm cả buổi không chấm được cho MỌI học viên, lại còn im lặng ở
 * nút "Xóa feedback" (nó dùng chung hàm này).
 *
 * Ràng buộc chặn đường nới rộng hơn nữa: KHÔNG được nuốt "Bài làm của học
 * viên", header của bảng BÀI TẬP TỰ CHỌN vốn cố ý không bao giờ được chấm. Vì
 * thế vẫn phải neo vào chữ "chữa"/"GV sửa", không nới theo cấu trúc bảng.
 */
const FEEDBACK_HEADER = /(gv\s*s[uử]a|ch[uữ]a)(?![\p{L}])/iu;
/** Bảng dạng 2: header có cả "chủ động" lẫn "bị động". */
const ACTIVE_HEADER = /c[aâ]u\s*ch[uủ]\s*đ[oộ]ng/i;
const PASSIVE_HEADER = /b[iị]\s*đ[oộ]ng/i;
/**
 * Dòng "Học viên thành lập công thức … bị động" (ô B1:/B2:). Chỉ dùng để KHÔNG
 * lấy nhầm nó làm tín hiệu dạng 2 — bản thân nó cũng chứa chữ "bị động". Việc
 * không chấm các ô đó là do quy tắc cấp dòng lo, không phải do regex này.
 */
const FORMULA_HEADER = /th[aà]nh\s*l[aậ]p\s*c[oô]ng\s*th[uứ]c/i;
/**
 * Header cột cuối của bảng BÀI TẬP TỰ CHỌN. Bảng này cố ý KHÔNG chấm, nhưng
 * học viên vẫn làm, nên nó trông y hệt một bảng bài tập "không nhận ra được" —
 * chỉ dùng để khỏi cảnh báo nhầm về nó (buổi 02 lớp KTN707: bảng 10 bị báo
 * cho cả 24 học viên).
 */
const OPTIONAL_HEADER = /b[aà]i\s*l[aà]m\s*c[uủ]a\s*h[oọ]c\s*vi[eê]n/i;

/**
 * Bảng "Bài tập viết đoạn văn" (mọi buổi 02 → 23 cùng một bố cục 3×3):
 *
 *   | Bài tập viết đoạn văn: <chủ đề> (gộp 2 ô) |          | GV sửa |
 *   | Đoạn văn mẫu                              | <mẫu>    |        |
 *   | Học viên viết                             | <bài HV> | <ô ghi feedback> |
 *
 * Hai nhãn dòng được neo CẢ Ô (^…$): một header bài câu kiểu "Học viên viết lại
 * câu sau" không được phép biến bảng đó thành bảng đoạn văn.
 */
const PARAGRAPH_TITLE = /vi[eế]t\s*đo[aạ]n\s*v[aă]n/i;
const PARAGRAPH_SAMPLE_LABEL = /^\s*đo[aạ]n\s*v[aă]n\s*m[aẫ]u\s*:?\s*$/i;
const PARAGRAPH_STUDENT_LABEL = /^\s*h[oọ]c\s*vi[eê]n\s*vi[eế]t\s*:?\s*$/i;
/** Gạch chân dạng ký tự tổ hợp ("H̲e̲y̲") có trong đoạn mẫu buổi 03. */
const COMBINING_LOW_LINE = /̲/g;

/** Mọi bảng trong tab, kèm chỉ số theo đúng thứ tự tài liệu. */
function listTables(tab) {
  return (tab?.documentTab?.body?.content || [])
    .flatMap((block) => block.table || [])
    .map((table, tableIdx) => ({ tableIdx, table }));
}

/**
 * Chữ của từng ô trong "dải header" = mọi dòng đứng TRƯỚC câu hỏi đầu tiên.
 *
 * Không thể chốt cứng "3 dòng đầu": bảng dạng 2 mở đầu bằng dòng ví dụ, rồi
 * dải công thức, mãi dòng thứ tư mới tới header thật
 * ("Câu Chủ động → Câu Bị động"). Lấy mốc là câu hỏi đầu tiên thì đúng cho mọi
 * bố cục mà không phải đếm.
 *
 * Trả về MẢNG từng ô, không phải một chuỗi gộp: tín hiệu phân loại phải đọc
 * được trong phạm vi MỘT ô, nếu không "…công thức HTĐ bị động" ở ô này và
 * "HTĐ chủ động" ở ô kia sẽ cộng lại thành một bảng chủ động → bị động giả.
 */
function headerCellTexts(table) {
  const rows = table.tableRows || [];
  const texts = [];
  for (const row of rows) {
    if (resolveRowCells(row)) break;
    for (const cell of row.tableCells || []) {
      texts.push(normalizeText(getCellText(cell)));
    }
  }
  return texts;
}

/** Dòng nào của bảng là dòng "Nhận xét chung của Giáo viên", hay -1. */
function findOverallRowIdx(table) {
  const rows = table.tableRows || [];
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const cells = rows[rowIdx].tableCells || [];
    // Quét CẢ dòng chứ không chỉ ô 0: đây là dòng một ô gộp hết chiều ngang.
    if (
      cells.some((cell) => getCellText(cell).includes(OVERALL_FEEDBACK_LABEL))
    )
      return rowIdx;
  }
  return -1;
}

/** Số dòng có hình dạng câu hỏi (có số thứ tự, có ô cuối để ghi feedback). */
function countQuestionRows(table) {
  return (table.tableRows || []).filter((row) => resolveRowCells(row)).length;
}

/**
 * Số câu HỌC VIÊN THỰC SỰ ĐÃ LÀM trong bảng.
 *
 * Khác `countQuestionRows` ở chỗ đòi có câu trả lời thật. Đây mới là tín hiệu
 * "bảng này là bài tập": một bảng lý thuyết hay bảng ví dụ cũng có dòng đánh số
 * ("1. Câu bị động | be + PII"), nhưng không ai điền gì vào đó cả.
 */
function countAnsweredRows(table, tableIdx) {
  const entries = (table.tableRows || [])
    .map((row, rowIdx) => {
      const cells = resolveRowCells(row);
      return cells ? { tableIdx, rowIdx, qCell: cells.qCell } : null;
    })
    .filter(Boolean);
  return getQuesAndAnsFromRows(entries).length;
}

/** Số cột của bảng, đo bằng dòng rộng nhất (dòng gộp ô hẹp hơn). */
function columnCount(table) {
  return (table.tableRows || []).reduce(
    (max, row) => Math.max(max, (row.tableCells || []).length),
    0,
  );
}

/**
 * Loại bài của một bảng, hoặc null nếu bảng này không phải bảng bài tập.
 * `vi_en` là mặc định: nó phủ cả header cũ ("Đề bài") lẫn header mới
 * ("Tiếng Việt → Tiếng Anh"), nên một bảng bài tập lạ vẫn được chấm như bài
 * dịch thay vì bị bỏ rơi im lặng.
 */
function classifyTable(table) {
  if (!countQuestionRows(table)) return null;

  const header = headerCellTexts(table);
  if (!header.some((text) => FEEDBACK_HEADER.test(text))) return null;

  // Ô "Học viên thành lập công thức HTĐ bị động" cũng nói "bị động", nhưng nó
  // mô tả bài điền công thức chứ không phải bài chuyển câu — bỏ ra trước khi
  // kết luận, nếu không mọi bảng dạng 2 lẫn dạng 1 có dải công thức đều bị gán
  // nhầm loại.
  const claims = header.filter((text) => !FORMULA_HEADER.test(text));
  if (
    claims.some((text) => ACTIVE_HEADER.test(text) && PASSIVE_HEADER.test(text))
  ) {
    return KIND_ACTIVE_PASSIVE;
  }
  return KIND_VI_EN;
}

/**
 * Ô NHÃN của một dòng (ô đầu tiên có chữ) và vị trí của nó, hay null. Ô giữ chỗ
 * của một ô gộp có thể đứng trước — Docs API trả nó về rỗng hoặc lược hẳn —
 * nên không được giả định nhãn luôn ở ô 0.
 */
function rowLabel(row) {
  const cells = row?.tableCells || [];
  for (let i = 0; i < cells.length; i++) {
    const text = getCellText(cells[i]).trim();
    if (text) return { index: i, text };
  }
  return null;
}

/** Ô nội dung của một dòng nhãn: ô có `content` đầu tiên sau nhãn, trừ ô cuối. */
function cellAfterLabel(row, labelIndex) {
  const cells = row?.tableCells || [];
  for (let i = labelIndex + 1; i < cells.length - 1; i++) {
    if (cells[i]?.content) return cells[i];
  }
  return null;
}

/**
 * Nhận diện bảng "Bài tập viết đoạn văn" theo NỘI DUNG.
 *
 * Bảng này không có dòng đánh số nên `classifyTable` không bao giờ nhận ra nó —
 * trước khi có hàm này, cả bảng bị bỏ qua mà không có cảnh báo nào.
 *
 * @returns {{
 *   studentRowIdx: number, qCell: object, fbCell: object, promptText: string,
 * }|null} null khi đây không phải bảng đoạn văn, hoặc khi ô ghi feedback không
 *   có vị trí để ghi (không đoán).
 */
function resolveParagraphTable(table) {
  const rows = table.tableRows || [];
  const studentRowIdx = rows.findIndex((row) =>
    PARAGRAPH_STUDENT_LABEL.test(rowLabel(row)?.text || ""),
  );
  if (studentRowIdx === -1) return null;

  const headerTexts = rows
    .slice(0, studentRowIdx)
    .flatMap((row) => row.tableCells || [])
    .map((cell) => normalizeText(getCellText(cell)));
  if (!headerTexts.some((text) => FEEDBACK_HEADER.test(text))) return null;

  const studentRow = rows[studentRowIdx];
  const cells = studentRow.tableCells || [];
  const qCell = cellAfterLabel(studentRow, rowLabel(studentRow).index);
  const fbCell = cells[cells.length - 1];
  if (!qCell || !fbCell || fbCell === qCell) return null;
  if (fbCell.content?.[0]?.startIndex === undefined) return null;

  const title = headerTexts.find((text) => PARAGRAPH_TITLE.test(text)) || "";
  const topic = title.includes(":")
    ? title.slice(title.indexOf(":") + 1).trim()
    : "";

  let sample = "";
  for (const row of rows) {
    const label = rowLabel(row);
    if (label && PARAGRAPH_SAMPLE_LABEL.test(label.text)) {
      sample = getCellText(cellAfterLabel(row, label.index)).trim();
      break;
    }
  }

  const promptText = [
    topic && `Chủ đề: ${topic}`,
    sample && `Đoạn văn mẫu:\n${sample}`,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(COMBINING_LOW_LINE, "");

  return { studentRowIdx, qCell, fbCell, promptText };
}

/** Chỉ số bảng do TABLE_OVERRIDES ép cho tab này, hoặc null. */
function overrideFor(tabName, classType) {
  const found = (TABLE_OVERRIDES || []).find(
    (item) =>
      String(tabName ?? "").includes(item.tabName) &&
      (!item.classType || item.classType === classType),
  );
  return found ? found.tableIndex : null;
}

/**
 * Nhận diện mọi bảng bài tập của một tab.
 *
 * @returns {{
 *   tables: Array<{tableIdx: number, kind: string, table: object}>,
 *   overall: {tableIdx: number, rowIdx: number}|null,
 *   unclassifiedWithQuestions: number[],
 * }}
 */
export function detectTables(tab, classType) {
  const all = listTables(tab);

  let overall = null;
  for (const { tableIdx, table } of all) {
    const rowIdx = findOverallRowIdx(table);
    if (rowIdx !== -1) {
      overall = { tableIdx, rowIdx };
      break;
    }
  }

  // Bảng đoạn văn được nhận diện TRƯỚC và ĐỘC LẬP với mọi thứ bên dưới — kể
  // cả TABLE_OVERRIDES, vốn chỉ dùng để ép chỉ số cho bảng CÂU. Một đường nhận
  // diện duy nhất, để override không bao giờ làm mất hay ép sai loại đoạn văn.
  const paragraphs = new Map();
  for (const { tableIdx, table } of all) {
    const paragraph = resolveParagraphTable(table);
    if (paragraph) paragraphs.set(tableIdx, paragraph);
  }
  const asParagraph = ({ tableIdx, table }) => ({
    tableIdx,
    table,
    kind: KIND_PARAGRAPH,
    paragraph: paragraphs.get(tableIdx),
  });

  const forced = overrideFor(tab?.tabProperties?.title, classType);
  if (forced) {
    const wanted = new Set(forced);
    return {
      tables: all
        .filter(
          ({ tableIdx }) => wanted.has(tableIdx) || paragraphs.has(tableIdx),
        )
        .map((item) =>
          paragraphs.has(item.tableIdx)
            ? asParagraph(item)
            : {
                tableIdx: item.tableIdx,
                table: item.table,
                kind: classifyTable(item.table) || KIND_VI_EN,
              },
        ),
      overall,
      unclassifiedWithQuestions: [],
    };
  }

  const tables = [];
  const unclassifiedWithQuestions = [];
  let previousKind = null;
  let previousColumns = 0;

  for (const { tableIdx, table } of all) {
    if (paragraphs.has(tableIdx)) {
      tables.push(asParagraph({ tableIdx, table }));
      // Bảng ngay sau không được "kế thừa loại" từ bảng đoạn văn: nó không
      // phải mảnh ngắt trang của một bảng câu.
      previousKind = null;
      previousColumns = 0;
      continue;
    }
    const kind = classifyTable(table);
    if (kind) {
      tables.push({ tableIdx, table, kind });
      previousKind = kind;
      previousColumns = columnCount(table);
      continue;
    }

    // Bảng bị NGẮT TRANG tách làm đôi: mảnh sau không có dòng header nên tự nó
    // không phân loại được, nhưng vẫn đầy câu hỏi của học viên. Cho nó kế thừa
    // loại của bảng ngay trước, với điều kiện cùng số cột — nếu không, nửa bài
    // tập sẽ rơi mất mà không ai biết.
    // Bảng TỰ CHỌN có header riêng nên không thể là mảnh bị ngắt trang, và
    // tuyệt đối không được chấm — kể cả khi nó cùng số cột với bảng trước.
    const optional = headerCellTexts(table).some((text) =>
      OPTIONAL_HEADER.test(text),
    );
    const questions = countQuestionRows(table);
    if (
      questions &&
      !optional &&
      previousKind &&
      columnCount(table) === previousColumns
    ) {
      tables.push({ tableIdx, table, kind: previousKind, continuation: true });
      continue;
    }

    // Có bài HỌC VIÊN ĐÃ LÀM mà không nhận ra được loại ⇒ BÁO, đừng im lặng.
    // Im lặng chính là thứ đã khiến buổi 06/07/08 nhiều tháng liền chấm không
    // ra gì. Điều kiện là "đã có câu trả lời", không phải "có đánh số": bảng lý
    // thuyết cũng đánh số, và cảnh báo sai chỗ thì chẳng mấy mà bị bỏ qua hết.
    if (
      questions &&
      columnCount(table) >= 2 &&
      !optional &&
      countAnsweredRows(table, tableIdx)
    ) {
      unclassifiedWithQuestions.push(tableIdx);
    }
    previousKind = null;
    previousColumns = 0;
  }

  return { tables, overall, unclassifiedWithQuestions };
}

/**
 * Mọi dòng đáng quan tâm của một tab, đã giải sẵn ô nào là đề bài / ô nào nhận
 * feedback, kèm danh tính bảng.
 *
 * Trả về MẢNG PHẲNG vì mọi nơi tiêu thụ đều duyệt tuyến tính, nhưng khác
 * `getTablesWhichContainStudentExercise` cũ ở chỗ mỗi phần tử tự mang
 * `tableIdx`/`rowIdx`/`kind` và các ô đã giải — nhờ đó bỏ được ba chỗ đoán theo
 * vị trí (bỏ 2 dòng đầu, `j > 1`, "bảng nhận xét chung phải nằm cuối").
 *
 * @returns {{
 *   rows: Array<{
 *     tableIdx, rowIdx, kind, row,
 *     qCell, fbCell, numberCell,
 *     isOverall, overallCell,
 *   }>,
 *   unclassifiedWithQuestions: number[],
 * }}
 */
export function collectExerciseRows(tab, classType) {
  const { tables, overall, unclassifiedWithQuestions } = detectTables(
    tab,
    classType,
  );
  const rows = [];

  for (const { tableIdx, table, kind, paragraph } of tables) {
    // Cả bảng đoạn văn là MỘT dòng bài tập: dòng "Học viên viết".
    if (kind === KIND_PARAGRAPH) {
      rows.push({
        tableIdx,
        rowIdx: paragraph.studentRowIdx,
        kind,
        row: table.tableRows[paragraph.studentRowIdx],
        qCell: paragraph.qCell,
        fbCell: paragraph.fbCell,
        numberCell: null,
        promptText: paragraph.promptText,
        isOverall: false,
        overallCell: null,
      });
      continue;
    }
    (table.tableRows || []).forEach((row, rowIdx) => {
      const cells = resolveRowCells(row);
      if (!cells) return;
      rows.push({
        tableIdx,
        rowIdx,
        kind,
        row,
        qCell: cells.qCell,
        fbCell: cells.fbCell,
        numberCell: cells.numberCell,
        isOverall: false,
        overallCell: null,
      });
    });
  }

  if (overall) {
    const table = listTables(tab).find(
      (item) => item.tableIdx === overall.tableIdx,
    )?.table;
    const row = (table?.tableRows || [])[overall.rowIdx];
    if (row) {
      rows.push({
        tableIdx: overall.tableIdx,
        rowIdx: overall.rowIdx,
        kind: null,
        row,
        qCell: null,
        fbCell: null,
        numberCell: null,
        isOverall: true,
        overallCell: (row.tableCells || []).find((cell) =>
          getCellText(cell).includes(OVERALL_FEEDBACK_LABEL),
        ),
      });
    }
  }

  return { rows, unclassifiedWithQuestions };
}
