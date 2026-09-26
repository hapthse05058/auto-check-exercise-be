/**
 * Đọc bảng Markdown do AI trả về thành map { STT -> "Chữa bài" }.
 *
 * Tách khỏi server.js để test được mà không phải khởi động Express +
 * firebase-admin — cùng lý do với ./gradingKey.js. Ở đây điều đó còn quan trọng
 * hơn: hàm này là chốt chặn cuối cùng trước khi feedback được ghi vào
 * gradingCache, và một lỗi của nó là lỗi VĨNH VIỄN (feedback sai nằm lại trong
 * cache, phục vụ mãi, không ngoại lệ nào được ném ra để lần theo).
 */

/**
 * @param {string} aiText  Nguyên văn phản hồi của AI.
 * @param {number} expected  Số item trong group — STT hợp lệ là 1..expected.
 * @returns {Object<string, string>} map STT -> nội dung cột "Chữa bài".
 *
 * Ném lỗi khi STT TRÙNG hoặc NẰM NGOÀI 1..expected — dấu hiệu model đã tách
 * DATASET hỗn hợp thành hai bảng (đánh số lại từ 1, hoặc đánh số nối tiếp vượt
 * ngưỡng). Khi đó feedback bị gán SAI NGƯỜI: đủ số dòng, không lỗi nào ném ra,
 * rồi nằm lại trong gradingCache vĩnh viễn. Thà để group này fail và chấm lại.
 *
 * CỐ Ý KHÔNG kiểm tra "thiếu STT": thiếu là chế độ hỏng AN TOÀN. Người gọi tra
 * theo GIÁ TRỊ STT chứ không theo vị trí dòng, nên một STT vắng mặt chỉ làm
 * đúng item đó nhận null — không ghi cache, tự chấm lại lần sau — còn các câu
 * kia vẫn đúng. Fail cả group vì một câu thiếu là vứt đi 14 lần chấm đã trả tiền.
 */
function parseGradedTable(aiText, expected) {
  const map = {};
  const lines = String(aiText ?? "").split("\n");
  // Số cột lấy từ dòng header, để parser không chết cứng vào bảng 4 cột: nếu
  // sau này rút bớt cột để tiết kiệm output token, chỗ này không phải sửa.
  const columnCount = headerColumnCount(lines);

  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cleanLine = line.trim().replace(/^\||\|$/g, "");
    const parts = cleanLine.split("|");
    const columns = parts.map((col) => col.trim());
    // Dòng dữ liệu thật có đủ cột và cột đầu là SỐ. Chỉ riêng điều kiện "cột
    // đầu là số" đã loại cả dòng header lẫn dòng phân cách ("---", ":---:",
    // "---:"), kể cả khi model lặp lại chúng ở giữa bảng — nên không cần lọc
    // theo "---" nữa. Lọc như thế còn nuốt nhầm dòng dữ liệu có chứa "---".
    if (columns.length < columnCount || !/^\d+$/.test(columns[0])) continue;

    const stt = columns[0];
    if (Object.prototype.hasOwnProperty.call(map, stt)) {
      throw new Error(`duplicate STT ${stt} in AI table`);
    }
    if (Number(stt) < 1 || Number(stt) > expected) {
      throw new Error(`STT ${stt} out of range 1..${expected}`);
    }
    // "Chữa bài" là cột CUỐI, nên mọi thứ từ cột đó trở đi đều là feedback.
    // Nối lại từ `parts` (chưa trim từng mảnh) để một dấu "|" model lỡ viết
    // trong lời giải thích chỉ làm xấu chữ, thay vì cắt cụt feedback — và để
    // khoảng trắng hai bên dấu "|" đó không bị nuốt mất.
    map[stt] = parts
      .slice(columnCount - 1)
      .join("|")
      .trim();
  }
  return map;
}

/**
 * Số cột của bảng, đọc từ dòng header đầu tiên (dòng có "STT" ở cột đầu).
 * Không thấy header thì giữ mặc định 4 cột như định dạng hiện hành.
 */
function headerColumnCount(lines) {
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const columns = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((col) => col.trim());
    if (columns.length >= 2 && columns[0].toUpperCase() === "STT") {
      return columns.length;
    }
  }
  return 4;
}

module.exports = { parseGradedTable };
