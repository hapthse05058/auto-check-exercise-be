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
/** "Bài tập viết đoạn văn": đề = chủ đề + đoạn mẫu, trả lời = cả đoạn học viên viết. */
const TASK_PARAGRAPH = "paragraph";
const TASK_TYPES = [TASK_VI_EN, TASK_ACTIVE_PASSIVE, TASK_PARAGRAPH];

/** Loại bài hợp lệ, hoặc "vi_en" cho mọi thứ khác (kể cả bản ghi cũ không có). */
function normalizeTaskType(value) {
  return TASK_TYPES.includes(value) ? value : TASK_VI_EN;
}

function normalizeForKey(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Số thứ tự đầu câu: "1.", "12)", "3 .". `(?!\d)` để "3.5 million…" không bị
// cắt thành "5 million…".
const LEADING_NUMBER = /^\d{1,3}\s*[.)](?!\d)/;
// Nhãn trả lời chữ ("Ans:", "TL:", "Trả lời:", "Đáp án -"). Phải có dấu câu
// theo sau, nên "Trả lời câu hỏi sau" (đề bài) không bị đụng tới. Mũi tên
// không cần liệt kê: nó không phải chữ/số nên LEADING_JUNK đã cắt.
const LEADING_LABEL =
  /^(?:ans(?:wer)?|tl|tr[ảa]\s*l[ờo]i|đ[áa]p\s*[áa]n)\s*[:.\-–—]/iu;
// Mọi thứ không phải chữ/số ở hai đầu dòng: mũi tên, dấu chấm, ngoặc/nháy dư,
// dấu cách… `\p{M}` là dấu tổ hợp — thiếu nó, chữ có dấu viết dạng NFD ở cuối
// câu ("ệ" = "e" + dấu) sẽ bị cắt mất dấu. Cuối câu chỉ giữ thêm "?" và "!".
const LEADING_JUNK = /^[^\p{L}\p{N}\p{M}]+/u;
const TRAILING_JUNK = /[^\p{L}\p{N}\p{M}?!]+$/u;

// Dấu đóng chỉ là "dư" khi không có dấu mở tương ứng trong nội dung:
// "I study.)" → "I study", nhưng "(Sách/trà nói chung)." giữ ")". Không có
// "'" thẳng: nó còn là dấu nháy lược ("don't") nên đếm chẵn/lẻ vô nghĩa.
const CLOSERS = [
  ['"', '"'],
  ["“", "”"],
  ["‘", "’"],
  ["[", "]"],
  ["(", ")"],
];
const countOf = (text, ch) => text.split(ch).length - 1;

function stripTrailing(text) {
  const match = text.match(TRAILING_JUNK);
  if (!match) return text;
  let body = text.slice(0, match.index);
  const tail = match[0];
  for (const [open, close] of CLOSERS) {
    if (!tail.includes(close)) continue;
    const unclosed =
      open === close
        ? countOf(body, open) % 2 === 1
        : countOf(body, open) > countOf(body, close);
    if (unclosed) body += close;
  }
  return body;
}

function cleanLine(line) {
  let out = line.replace(/\s+/g, " ").trim();
  for (;;) {
    const next = out
      .replace(LEADING_JUNK, "")
      .replace(LEADING_NUMBER, "")
      .replace(LEADING_LABEL, "")
      .replace(LEADING_JUNK, "");
    if (next === out) break;
    out = next;
  }
  return stripTrailing(out);
}

/**
 * Chỉ giữ NỘI DUNG của một câu hỏi/câu trả lời: bỏ tiền tố (số thứ tự, mũi
 * tên, nhãn "Trả lời:", ký tự lạ) và hậu tố (dấu chấm, ngoặc/nháy dư, ký tự
 * lạ — chỉ giữ "?" và "!"). Làm theo TỪNG DÒNG vì một câu hỏi có thể gồm nhiều
 * dòng ("câu đơn" + "câu phức"). Idempotent, nên gọi lại trên chữ đã sạch là
 * vô hại.
 */
function cleanContent(value) {
  return String(value ?? "")
    .split(/\r?\n|\v/)
    .map(cleanLine)
    .filter(Boolean)
    .join("\n");
}

/**
 * Deterministic gradingCache document id from explicit key fields. Keyed on
 * promptVersion + model + cleaned question + cleaned answer + taskType,
 * so identical answers share one doc and prompt/model changes naturally
 * invalidate old feedback. Used both by grading and by the admin management
 * endpoints (which must re-key a doc when any key field is edited).
 *
 * Hậu tố taskType là CÓ ĐIỀU KIỆN, không phải luôn luôn: nối vô điều kiện sẽ
 * đổi mọi hash đang có, tức tương đương xoá sạch cache và chấm lại toàn bộ kho
 * câu với chi phí DeepSeek thật. Bỏ hậu tố cho "vi_en" giữ khoá của bài dịch —
 * gần như toàn bộ cache hiện tại — giống hệt từng byte so với trước.
 * `section` (tiêu đề nhóm câu, vd "Be going to: …") cũng là hậu tố có điều
 * kiện, cùng lý do.
 */
function gradingCacheKey(
  promptVersion,
  model,
  question,
  answer,
  taskType,
  section,
) {
  // Chuẩn hoá NGAY TẠI ĐÂY, đừng tin người gọi: một giá trị lạ (client cũ, gõ
  // sai, loại bài thêm sau này) mà lọt thẳng vào hash sẽ âm thầm mở ra một
  // nhánh cache riêng — mọi câu trong đó là cache miss vĩnh viễn, chấm lại mãi
  // và tốn tiền mãi, mà không có lỗi nào báo ra.
  const kind = normalizeTaskType(taskType);
  const suffix = kind !== TASK_VI_EN ? `|${kind}` : "";
  // Làm sạch cũng tại đây: "1. Tôi học." + "→ I study." và "Tôi học" + "I
  // study" phải là MỘT bản ghi. Định dạng chuỗi hash không đổi, nên bản ghi vốn
  // đã sạch giữ nguyên id.
  const q = normalizeForKey(cleanContent(question));
  const a = normalizeForKey(cleanContent(answer));
  // The heading a question sits under ("Be going to: …") — same conditional
  // rule: no heading, no suffix, so every key without one stays as it was.
  const sec = normalizeForKey(section);
  const secSuffix = sec ? `|sec:${sec}` : "";
  const raw = `${promptVersion}|${model}|${q}|${a}${suffix}${secSuffix}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function toMillis(value) {
  if (value?.toMillis) return value.toMillis();
  const ms = value ? new Date(value).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Kế hoạch dọn gradingCache theo quy tắc làm sạch: tính lại id của từng bản
 * ghi, gộp những bản ghi trùng id mới (giữ bản hitCount cao nhất, hoà thì bản
 * mới nhất; hitCount cộng dồn) và xoá phần còn lại. Hàm thuần — script chỉ
 * việc thực thi `writes`/`deletes`.
 *
 * @param {Array<{id: string, data: object}>} docs
 * @returns {{writes: Array<{id, data, from: string[]}>, deletes: string[],
 *            skipped: Array<{id, reason}>}}
 */
function planCacheCleanup(docs) {
  const groups = new Map();
  const skipped = [];
  for (const doc of docs) {
    const data = doc.data || {};
    const question = cleanContent(data.question);
    const answer = cleanContent(data.answer);
    if (!question || !answer) {
      skipped.push({ id: doc.id, reason: "empty_after_clean" });
      continue;
    }
    const newId = gradingCacheKey(
      data.promptVersion,
      data.model,
      question,
      answer,
      data.taskType,
      data.section,
    );
    if (!groups.has(newId)) groups.set(newId, []);
    groups.get(newId).push({ id: doc.id, data, question, answer });
  }

  const writes = [];
  const deletes = [];
  for (const [newId, members] of groups) {
    const winner = members.reduce((best, m) => {
      const diff =
        (Number(m.data.hitCount) || 0) - (Number(best.data.hitCount) || 0);
      if (diff !== 0) return diff > 0 ? m : best;
      return toMillis(m.data.createdAt) > toMillis(best.data.createdAt)
        ? m
        : best;
    });
    const hitCount = members.reduce(
      (sum, m) => sum + (Number(m.data.hitCount) || 0),
      0,
    );
    const unchanged =
      members.length === 1 &&
      winner.id === newId &&
      winner.question === winner.data.question &&
      winner.answer === winner.data.answer;
    if (unchanged) continue;

    writes.push({
      id: newId,
      from: members.map((m) => m.id),
      data: {
        ...winner.data,
        question: winner.question,
        answer: winner.answer,
        taskType: normalizeTaskType(winner.data.taskType),
        hitCount,
      },
    });
    members.forEach((m) => {
      if (m.id !== newId) deletes.push(m.id);
    });
  }
  return { writes, deletes, skipped };
}

module.exports = {
  TASK_ACTIVE_PASSIVE,
  TASK_PARAGRAPH,
  TASK_TYPES,
  TASK_VI_EN,
  cleanContent,
  gradingCacheKey,
  normalizeForKey,
  normalizeTaskType,
  planCacheCleanup,
};
