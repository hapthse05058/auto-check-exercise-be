/**
 * Chấm "Bài tập viết đoạn văn": dựng dataset gửi AI, đọc JSON AI trả về, và
 * định dạng feedback ghi vào ô "GV sửa".
 *
 * Tách khỏi server.js để test được mà không phải khởi động Express +
 * firebase-admin. `callGrader` được truyền vào nên test không gọi AI thật.
 *
 * NGUYÊN TẮC XUYÊN SUỐT: thiếu hay hỏng thì trả `null`, không bao giờ trả
 * "✅ Đúng". `null` nghĩa là không lưu cache, không ghi doc, lần chạy sau chấm
 * lại; còn một "✅ Đúng" sai thì bị cache lại và dán vào bài của mọi học viên
 * viết y hệt, mãi mãi.
 */

/** Phải trùng `IS_CORRECT_ANSWER` của lib/doc/docParser.js (test kiểm tra). */
const IS_CORRECT_ANSWER = "✅ Đúng";

/**
 * Đọc JSON AI trả về thành Map<stt, corrections[]>.
 *
 * Chỉ nhận item có `corrections` LÀ MẢNG: thiếu trường đó thì item coi như
 * không có, để nó ra `null` chứ không thành "đúng hết".
 */
function parseParagraphResponse(text) {
  const byStt = new Map();
  let raw = String(text ?? "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) raw = fenced[1].trim();
  // Có model thêm chữ trước/sau object: cắt đúng phần { … } ngoài cùng.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return byStt;

  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return byStt;
  }
  for (const item of Array.isArray(data?.items) ? data.items : []) {
    const stt = Number(item?.stt);
    if (!Number.isInteger(stt) || !Array.isArray(item.corrections)) continue;
    if (!byStt.has(stt)) byStt.set(stt, item.corrections);
  }
  return byStt;
}

/** Bỏ MỘT cặp ngoặc bọc ngoài mà model tự thêm, vì phần mềm cũng thêm. */
function stripOuterParens(text) {
  const match = text.match(/^\((.*)\)$/s);
  return match ? match[1].trim() : text;
}

/**
 * Feedback ghi vào ô "GV sửa":
 *
 *   <câu đã sửa, phần sửa bọc **>
 *   (<giải thích>)
 *   <dòng trống>
 *   <câu tiếp theo>…
 *
 * Làm CHẶT: chỉ cần một correction thiếu `sentence` hoặc `reason` là cả đoạn
 * ra `null`. Bỏ riêng correction hỏng thì doc sẽ âm thầm thiếu một lỗi của
 * học viên — tệ hơn là chấm lại ở lần sau.
 *
 * @returns {string|null}
 */
function formatParagraphFeedback(corrections) {
  if (!Array.isArray(corrections)) return null;
  if (corrections.length === 0) return IS_CORRECT_ANSWER;

  const blocks = [];
  for (const correction of corrections) {
    if (!correction || typeof correction !== "object") return null;
    const sentence = String(correction.sentence ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const reason = stripOuterParens(
      String(correction.reason ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (!sentence || !reason) return null;
    blocks.push(`${sentence}\n(${reason})`);
  }
  return blocks.join("\n\n");
}

/** Text gửi AI: giữ nguyên từng dòng (kể cả dấu "." cuối), chỉ bỏ dòng trống. */
function paragraphText(value) {
  return String(value ?? "")
    .split(/\r?\n|\v/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Chấm MỘT nhóm đoạn văn bằng một lần gọi AI.
 *
 * @param {Array<{question: string, answer: string}>} group
 * @param {{instruction: string, model: string,
 *          callGrader: (instruction, inputText, model) => Promise<string>}} deps
 * @returns {Promise<Array<string|null>>} thẳng hàng với `group`; STT AI bỏ sót
 *   hoặc trả hỏng → null.
 */
async function gradeParagraphGroup(group, { instruction, model, callGrader }) {
  const dataset = group
    .map(
      (item, i) =>
        `[STT]: ${i + 1}\n[ĐỀ + ĐOẠN MẪU]: ${paragraphText(item.question)}\n[ĐOẠN VĂN HỌC VIÊN]:\n${paragraphText(item.answer)}`,
    )
    .join("\n\n");
  const inputText = `DATASET:\n${dataset}\n\n[CRITICAL RULE]: Return ONLY the JSON object. Every [STT] above must have exactly one item.`;

  const response = await callGrader(instruction, inputText, model);
  const byStt = parseParagraphResponse(response);
  return group.map((_, i) => formatParagraphFeedback(byStt.get(i + 1)));
}

module.exports = {
  IS_CORRECT_ANSWER,
  formatParagraphFeedback,
  gradeParagraphGroup,
  paragraphText,
  parseParagraphResponse,
};
