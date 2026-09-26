const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildGradingInstruction,
  createInstructionBuilder,
  listLessonNumbers,
} = require("../lib/buildGradingInstruction.js");

const CORE = "QUY TẮC CHẤM CHUNG";

let dir;
let lessonsDir;
let coreFile;
let warnings;
let realWarn;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-"));
  lessonsDir = path.join(dir, "lessons");
  fs.mkdirSync(lessonsDir);
  coreFile = path.join(dir, "system_instruction_core.txt");
  fs.writeFileSync(coreFile, `${CORE}\n`, "utf8");
  fs.writeFileSync(
    path.join(lessonsDir, "lesson02.txt"),
    "BUỔI 02\nnội dung 02\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(lessonsDir, "lesson15.txt"),
    "BUỔI 15\nnội dung 15\n",
    "utf8",
  );
  // Fallback in cảnh báo — nuốt đi để log test khỏi lẫn, và để đếm được.
  warnings = [];
  realWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
});

afterEach(() => {
  console.warn = realWarn;
  fs.rmSync(dir, { recursive: true, force: true });
});

const build = (lessonId) =>
  buildGradingInstruction({ core: CORE, lessonsDir, lessonId });

test("chỉ gửi tài liệu của buổi được chỉ định", () => {
  const text = build("lesson15");
  assert.ok(text.startsWith(CORE), "core phải đứng đầu");
  assert.match(text, /### TÀI LIỆU THAM CHIẾU BUỔI 15/);
  assert.match(text, /nội dung 15/);
  assert.doesNotMatch(text, /nội dung 02/);
  assert.equal(warnings.length, 0);
});

test("lessonId thiếu hoặc sai dạng → fallback gửi mọi buổi + cảnh báo", () => {
  for (const lessonId of [undefined, null, "", "lesson9", "buoi15"]) {
    warnings = [];
    const text = build(lessonId);
    assert.match(text, /nội dung 02/);
    assert.match(text, /nội dung 15/);
    assert.equal(warnings.length, 1, `phải cảnh báo với lessonId=${lessonId}`);
  }
});

/**
 * Buổi 01, 19, 20 không có tài liệu trong tài liệu gốc. Gửi kèm tài liệu của
 * các buổi KHÁC vừa tốn gấp ~4 lần, vừa mời model lấy đáp án của buổi khác áp
 * cho buổi này — nên buổi thiếu file chỉ nhận core.
 */
test("buổi đúng dạng nhưng chưa có file → chỉ gửi core + cảnh báo", () => {
  const text = build("lesson03");
  assert.equal(text, `${CORE}\n`);
  assert.doesNotMatch(text, /nội dung/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /chưa có tài liệu cho buổi 03/);
});

test("lessonId không được dùng để đọc file ngoài thư mục lessons", () => {
  const secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "KHÔNG ĐƯỢC LỘ", "utf8");
  const text = build("../secret");
  assert.doesNotMatch(text, /KHÔNG ĐƯỢC LỘ/);
  assert.equal(warnings.length, 1);
});

test("core luôn là prefix giống hệt nhau giữa các buổi", () => {
  const a = build("lesson02");
  const b = build("lesson15");
  const prefix = `${CORE}\n\n`;
  assert.ok(a.startsWith(prefix));
  assert.ok(b.startsWith(prefix));
});

test("BOM và khoảng trắng thừa bị cắt để chuỗi ổn định từng byte", () => {
  const withBom = buildGradingInstruction({
    core: `\uFEFF${CORE}\n\n\n`,
    lessonsDir,
    lessonId: "lesson02",
  });
  assert.equal(withBom, build("lesson02"));
});

test("createInstructionBuilder trả về ĐÚNG CÙNG MỘT chuỗi cho cùng lessonId", () => {
  const instructionFor = createInstructionBuilder({ coreFile, lessonsDir });
  const first = instructionFor("lesson15");
  const second = instructionFor("lesson15");
  assert.equal(first, second);
  assert.ok(
    Object.is(first, second),
    "phải dùng lại chuỗi đã memo, không ghép lại",
  );
  assert.match(first, /nội dung 15/);
});

test("createInstructionBuilder gom mọi lessonId không hợp lệ về một bản fallback", () => {
  const instructionFor = createInstructionBuilder({ coreFile, lessonsDir });
  assert.ok(Object.is(instructionFor(null), instructionFor("buoi15")));
});

test("listLessonNumbers chỉ nhận file đúng tên lessonNN.txt", () => {
  fs.writeFileSync(path.join(lessonsDir, "lesson7.txt"), "x", "utf8");
  fs.writeFileSync(path.join(lessonsDir, "README.md"), "x", "utf8");
  assert.deepEqual(listLessonNumbers(lessonsDir), ["02", "15"]);
});
