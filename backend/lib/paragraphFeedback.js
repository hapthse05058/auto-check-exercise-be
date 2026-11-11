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
 * Đoạn văn không có lỗi nào — câu giáo viên yêu cầu thay cho "✅ Đúng". Phải
 * trùng `PARAGRAPH_ALL_CORRECT` của lib/doc/docParser.js (test kiểm tra).
 */
const PARAGRAPH_ALL_CORRECT = "Các câu đúng hết rồi nha! ^^";

// "nhé" ở cuối một ý ("… dùng “is” nhé.", "…; sau can → Vbare nhé;"): giáo
// viên yêu cầu bỏ khỏi nhận xét đoạn văn. Chỉ bỏ khi nó đứng cuối ý, trước dấu
// câu hoặc hết chuỗi.
const TRAILING_NHE = /\s*(?<![\p{L}])nh[ée](?![\p{L}])(?=\s*(?:[.,;!?]|$))/giu;

/** Lời giải thích không còn "nhé" cuối ý. */
function dropNhe(reason) {
  return reason.replace(TRAILING_NHE, "").trim();
}

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
  if (corrections.length === 0) return PARAGRAPH_ALL_CORRECT;

  const blocks = [];
  for (const correction of corrections) {
    if (!correction || typeof correction !== "object") return null;
    const sentence = String(correction.sentence ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const reason = dropNhe(
      stripOuterParens(
        String(correction.reason ?? "")
          .replace(/\s+/g, " ")
          .replace(/\bPII\b/g, "Pii")
          .trim(),
      ),
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

/** Một lần gọi AI cho `items`; kết quả thẳng hàng với `items`, hỏng → null. */
async function askParagraphs(items, { instruction, model, callGrader }) {
  const dataset = items
    .map(
      (item, i) =>
        `[STT]: ${i + 1}\n[ĐỀ + ĐOẠN MẪU]: ${paragraphText(item.question)}\n[ĐOẠN VĂN HỌC VIÊN]:\n${paragraphText(item.answer)}`,
    )
    .join("\n\n");
  const inputText = `DATASET:\n${dataset}\n\n[CRITICAL RULE]: Return ONLY the JSON object. Every [STT] above must have exactly one item.`;

  const response = await callGrader(instruction, inputText, model);
  const byStt = parseParagraphResponse(response);
  return items.map((_, i) => formatParagraphFeedback(byStt.get(i + 1)));
}

/**
 * Chấm MỘT nhóm đoạn văn bằng một lần gọi AI.
 *
 * Đoạn nào AI bỏ sót hoặc trả hỏng (thiếu STT, JSON cụt, correction thiếu
 * trường) được hỏi lại MỘT MÌNH, một lần — như bài câu (gradeGroupWithOpenAI).
 * Trả lời cho một đoạn thì ngắn hơn nhiều, nên hầu hết lần hỏng do nhóm quá
 * dài đều qua được. Vẫn hỏng thì để `null`: không cache, không ghi doc.
 *
 * Lần gọi cả nhóm lỗi thì ném ra như cũ. Lần hỏi lại lỗi thì KHÔNG ném — các
 * đoạn đã chấm xong của nhóm không được mất theo — mà báo qua `onFailure`.
 *
 * @param {Array<{question: string, answer: string}>} group
 * @param {{instruction: string, model: string,
 *          callGrader: (instruction, inputText, model) => Promise<string>,
 *          onFailure?: (err: Error) => void}} deps
 * @returns {Promise<Array<string|null>>} thẳng hàng với `group`; đoạn không
 *   chấm được → null.
 */
async function gradeParagraphGroup(
  group,
  { instruction, model, callGrader, onFailure },
) {
  const deps = { instruction, model, callGrader };
  const feedbacks = await askParagraphs(group, deps);
  // Nhóm chỉ có một đoạn thì hỏi lại y hệt lần vừa rồi — vẫn đáng một lần,
  // vì JSON hỏng thường là ngẫu nhiên chứ không do nội dung.
  await Promise.all(
    feedbacks.map(async (feedback, i) => {
      if (feedback !== null) return;
      try {
        [feedbacks[i]] = await askParagraphs([group[i]], deps);
      } catch (err) {
        onFailure?.(err);
      }
      if (feedbacks[i] === null) {
        console.warn(
          `[PARAGRAPH] no usable feedback after a single re-grade: ${JSON.stringify(
            String(group[i].answer ?? "").slice(0, 80),
          )}`,
        );
      }
    }),
  );
  return feedbacks;
}

module.exports = {
  IS_CORRECT_ANSWER,
  PARAGRAPH_ALL_CORRECT,
  formatParagraphFeedback,
  gradeParagraphGroup,
  paragraphText,
  parseParagraphResponse,
};
