/**
 * Khoá của gradingCache và loại bài tập.
 *
 * Tách khỏi server.js để test được mà không phải khởi động Express +
 * firebase-admin — và vì tính chất quan trọng nhất ở đây (khoá của bài dịch
 * KHÔNG được đổi) chỉ có thể chứng minh bằng test.
 */
const crypto = require("crypto");

/**
 * Loại bài tập, quyết định câu hỏi được ĐÓNG GÓI thế nào khi gửi cho AI.
 * "vi_en" là mặc định lịch sử: trước đây mọi item đều là bài dịch Việt → Anh.
 */
const TASK_VI_EN = "vi_en";
const TASK_ACTIVE_PASSIVE = "active_passive";
const TASK_TYPES = [TASK_VI_EN, TASK_ACTIVE_PASSIVE];

/** Loại bài hợp lệ, hoặc "vi_en" cho mọi thứ khác (kể cả bản ghi cũ không có). */
function normalizeTaskType(value) {
  return TASK_TYPES.includes(value) ? value : TASK_VI_EN;
}

function normalizeForKey(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic gradingCache document id from explicit key fields. Keyed on
 * promptVersion + model + normalized question + normalized answer + taskType,
 * so identical answers share one doc and prompt/model changes naturally
 * invalidate old feedback. Used both by grading and by the admin management
 * endpoints (which must re-key a doc when any key field is edited).
 *
 * Hậu tố taskType là CÓ ĐIỀU KIỆN, không phải luôn luôn: nối vô điều kiện sẽ
 * đổi mọi hash đang có, tức tương đương xoá sạch cache và chấm lại toàn bộ kho
 * câu với chi phí DeepSeek thật. Bỏ hậu tố cho "vi_en" giữ khoá của bài dịch —
 * gần như toàn bộ cache hiện tại — giống hệt từng byte so với trước.
 */
function gradingCacheKey(promptVersion, model, question, answer, taskType) {
  // Chuẩn hoá NGAY TẠI ĐÂY, đừng tin người gọi: một giá trị lạ (client cũ, gõ
  // sai, loại bài thêm sau này) mà lọt thẳng vào hash sẽ âm thầm mở ra một
  // nhánh cache riêng — mọi câu trong đó là cache miss vĩnh viễn, chấm lại mãi
  // và tốn tiền mãi, mà không có lỗi nào báo ra.
  const kind = normalizeTaskType(taskType);
  const suffix = kind !== TASK_VI_EN ? `|${kind}` : "";
  const raw = `${promptVersion}|${model}|${normalizeForKey(question)}|${normalizeForKey(answer)}${suffix}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

module.exports = {
  TASK_ACTIVE_PASSIVE,
  TASK_TYPES,
  TASK_VI_EN,
  gradingCacheKey,
  normalizeForKey,
  normalizeTaskType,
};
