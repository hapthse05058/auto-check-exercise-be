/**
 * Ghép system prompt cho một lần chấm: quy tắc chung (core) + tài liệu của
 * ĐÚNG buổi đang chấm.
 *
 * Trước đây mỗi request gửi tài liệu của TẤT CẢ các buổi (~115KB) dù một lần
 * chấm chỉ thuộc một buổi. Tách ra giúp cắt phần lớn input token.
 *
 * Hai điều kiện để prefix cache của DeepSeek còn tác dụng, và cũng là lý do
 * chuỗi được memo hoá thay vì ghép lại mỗi lần:
 *   1. core đứng TRƯỚC và cố định từng byte giữa mọi request;
 *   2. cùng một lessonId phải cho ra CÙNG MỘT chuỗi, không lệch một khoảng
 *      trắng nào.
 *
 * Tách khỏi server.js để test được mà không phải khởi động Express +
 * firebase-admin — cùng lý do với ./gradingKey.js và ./parseGradedTable.js.
 */
const fs = require("fs");
const path = require("path");

/**
 * lessonId là id document Firestore, dạng "lesson02".."lesson23". Chỉ chấp
 * nhận đúng dạng này: giá trị lạ KHÔNG được ghép thẳng vào đường dẫn file
 * (".." sẽ đọc ra ngoài thư mục lessons).
 */
const LESSON_ID = /^lesson(\d{2})$/;

/** Khoá memo cho trường hợp fallback (gửi tài liệu của mọi buổi). */
const ALL_LESSONS = "__all__";

function lessonFilePath(lessonsDir, num) {
  return path.join(lessonsDir, `lesson${num}.txt`);
}

/** Nội dung một buổi, hoặc null nếu chưa có file cho buổi đó. */
function readLesson(lessonsDir, num) {
  const file = lessonFilePath(lessonsDir, num);
  if (!fs.existsSync(file)) return null;
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
}

/** Số buổi ("02".."23") của mọi file có trong lessonsDir, đã sắp xếp tăng dần. */
function listLessonNumbers(lessonsDir) {
  return fs
    .readdirSync(lessonsDir)
    .map((name) => name.match(/^lesson(\d{2})\.txt$/))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

function section(num, body) {
  return `### TÀI LIỆU THAM CHIẾU BUỔI ${num}\n${body}`;
}

/**
 * @param {object} args
 * @param {string} args.core        Nội dung system_instruction_core.txt.
 * @param {string} args.lessonsDir  Thư mục chứa lessonNN.txt.
 * @param {string} [args.lessonId]  Id buổi học ("lesson15").
 * @returns {string} core + tài liệu buổi đó.
 *
 * Hai kiểu bất thường được xử lý KHÁC NHAU, vì nguyên nhân khác nhau:
 *
 * - lessonId ĐÚNG dạng nhưng chưa có file (buổi 01, 19, 20 không có tài liệu
 *   trong tài liệu gốc): chỉ gửi core. Gửi tài liệu của các buổi KHÁC vừa tốn
 *   gấp ~4 lần, vừa mời model lấy đáp án của buổi khác áp cho buổi này.
 * - lessonId thiếu hoặc sai dạng (client cũ, gõ sai): không biết đang chấm
 *   buổi nào, nên gửi tài liệu của mọi buổi — tốn token đúng như trước khi
 *   tối ưu, nhưng không câu nào bị chấm thiếu tài liệu.
 *
 * Cả hai đều kèm console.warn: đây là chuông báo, không phải đường đi bình
 * thường.
 */
function buildGradingInstruction({ core, lessonsDir, lessonId }) {
  const head = String(core)
    .replace(/^\uFEFF/, "")
    .trim();
  const match = LESSON_ID.exec(String(lessonId ?? ""));

  if (match) {
    const body = readLesson(lessonsDir, match[1]);
    if (body) return `${head}\n\n${section(match[1], body)}\n`;
    console.warn(
      `[PROMPT] chưa có tài liệu cho buổi ${match[1]} (lesson${match[1]}.txt), chỉ gửi quy tắc chấm chung`,
    );
    return `${head}\n`;
  }

  console.warn(
    `[PROMPT] lessonId không hợp lệ (${JSON.stringify(lessonId ?? null)}), gửi tài liệu của mọi buổi`,
  );
  const all = listLessonNumbers(lessonsDir)
    .map((num) => section(num, readLesson(lessonsDir, num)))
    .join("\n\n");
  return `${head}\n\n${all}\n`;
}

/**
 * Bản có memo cho server: đọc core + file buổi MỘT LẦN, giữ luôn chuỗi đã
 * ghép theo lessonId. Nhờ vậy hai request cùng buổi dùng lại đúng một chuỗi
 * trong bộ nhớ, không phụ thuộc việc ghép lại có ra kết quả giống hệt hay
 * không — điều kiện để prefix cache của DeepSeek hit.
 */
function createInstructionBuilder({ coreFile, lessonsDir }) {
  const cache = new Map();
  let core = null;
  return function instructionFor(lessonId) {
    const key = LESSON_ID.test(String(lessonId ?? ""))
      ? String(lessonId)
      : ALL_LESSONS;
    const hit = cache.get(key);
    if (hit) return hit;
    if (core === null) {
      core = fs.readFileSync(coreFile, "utf8");
    }
    const text = buildGradingInstruction({
      core,
      lessonsDir,
      lessonId: key === ALL_LESSONS ? null : key,
    });
    cache.set(key, text);
    return text;
  };
}

module.exports = {
  ALL_LESSONS,
  buildGradingInstruction,
  createInstructionBuilder,
  listLessonNumbers,
};
