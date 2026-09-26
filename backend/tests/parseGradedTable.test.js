const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parseGradedTable } = require("../lib/parseGradedTable.js");

const HEADER = "| STT | Đề bài | Câu trả lời của học sinh | Chữa bài |";
const SEP = "| --- | ------ | ------------------------- | -------- |";

/** Một bảng AI hợp lệ với các dòng cho trước. */
function table(...rows) {
  return [HEADER, SEP, ...rows].join("\n");
}

const row = (stt, fb) => `| ${stt} | đề ${stt} | → trả lời ${stt} | ${fb} |`;

test("đọc đúng cột Chữa bài theo STT", () => {
  const map = parseGradedTable(table(row(1, "✅ Đúng"), row(2, "sửa 2")), 2);
  assert.deepEqual(map, { 1: "✅ Đúng", 2: "sửa 2" });
});

test("bỏ qua dòng header và dòng phân cách, kể cả khi lặp giữa bảng", () => {
  const aiText = [
    HEADER,
    SEP,
    row(1, "✅ Đúng"),
    HEADER, // model chèn lại header ở chỗ chuyển loại bài
    SEP,
    row(2, "sửa 2"),
  ].join("\n");
  assert.deepEqual(parseGradedTable(aiText, 2), { 1: "✅ Đúng", 2: "sửa 2" });
});

/**
 * Hai test dưới đây là lý do hàm này tồn tại riêng một file. Model tách một
 * DATASET hỗn hợp thành hai bảng sẽ sinh STT trùng (đánh số lại từ 1) hoặc STT
 * vượt ngưỡng. Nếu không ném lỗi, feedback bị gán SAI NGƯỜI rồi nằm lại trong
 * gradingCache vĩnh viễn — không có ngoại lệ nào để lần theo.
 */
test("STT trùng → ném lỗi (không được âm thầm ghi đè)", () => {
  const aiText = table(row(1, "a"), row(2, "b"), row(1, "c"));
  assert.throws(() => parseGradedTable(aiText, 3), /duplicate STT 1/);
});

test("STT vượt ngoài 1..expected → ném lỗi", () => {
  const aiText = table(row(1, "a"), row(16, "b"));
  assert.throws(() => parseGradedTable(aiText, 15), /STT 16 out of range/);
});

/**
 * Ngược lại, THIẾU một STT là chế độ hỏng AN TOÀN và phải giữ nguyên như vậy:
 * người gọi tra theo GIÁ TRỊ STT nên item đó chỉ nhận null, không ghi cache, tự
 * chấm lại lần sau — còn các câu khác vẫn đúng. Biến nó thành lỗi là vứt đi
 * những lần chấm đã trả tiền.
 */
test("thiếu STT → KHÔNG ném lỗi, chỉ vắng khoá đó", () => {
  const map = parseGradedTable(table(row(1, "a"), row(2, "b"), row(4, "d")), 4);
  assert.deepEqual(map, { 1: "a", 2: "b", 4: "d" });
  assert.equal(map["3"], undefined);
});

test("dấu | trong lời giải thích không cắt cụt feedback", () => {
  const aiText = table(`| 1 | đề 1 | → trả lời 1 | sửa 1 (a | b) |`);
  assert.deepEqual(parseGradedTable(aiText, 1), { 1: "sửa 1 (a | b)" });
});

test("dòng phân cách kiểu căn lề vẫn bị bỏ qua", () => {
  for (const sep of [
    "| --- | --- | --- | --- |",
    "| :--- | :--- | :--- | :--- |",
    "| ---: | ---: | ---: | ---: |",
    "| :---: | :---: | :---: | :---: |",
  ]) {
    const aiText = [HEADER, sep, row(1, "a")].join("\n");
    assert.deepEqual(parseGradedTable(aiText, 1), { 1: "a" });
  }
});

test("dấu gạch trong lời giải thích KHÔNG bị bỏ cùng dòng phân cách", () => {
  const fb = "The man **lost** the key. (Vbqt: lose --- lost --- lost.)";
  assert.deepEqual(parseGradedTable(table(row(1, fb)), 1), { 1: fb });
});

test("bảng 3 cột: số cột đọc từ header, feedback vẫn là cột cuối", () => {
  const aiText = [
    "| STT | Câu trả lời của học sinh | Chữa bài |",
    "| --- | --- | --- |",
    "| 1 | → trả lời 1 | ✅ Đúng |",
    "| 2 | → trả lời 2 | sửa 2 (x | y) |",
  ].join("\n");
  assert.deepEqual(parseGradedTable(aiText, 2), {
    1: "✅ Đúng",
    2: "sửa 2 (x | y)",
  });
});

test("chữ quanh bảng và bảng rỗng không làm vỡ parser", () => {
  assert.deepEqual(parseGradedTable("", 3), {});
  assert.deepEqual(parseGradedTable("Chào bạn, đây là kết quả:", 3), {});
  assert.deepEqual(parseGradedTable(table(), 3), {});
});
