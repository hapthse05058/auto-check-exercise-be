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
  for (const line of String(aiText ?? "").split("\n")) {
    if (!line.includes("|") || line.includes("---")) continue;
    const cleanLine = line.trim().replace(/^\||\|$/g, "");
    const columns = cleanLine.split("|").map((col) => col.trim());
    // Real rows have >=4 columns and a numeric STT in column 0. Dòng header
    // ("STT") và dòng phân cách ("---") rụng ở đây, kể cả khi model lặp lại
    // chúng ở giữa bảng.
    if (columns.length >= 4 && /^\d+$/.test(columns[0])) {
      const stt = columns[0];
      if (Object.prototype.hasOwnProperty.call(map, stt)) {
        throw new Error(`duplicate STT ${stt} in AI table`);
      }
      if (Number(stt) < 1 || Number(stt) > expected) {
        throw new Error(`STT ${stt} out of range 1..${expected}`);
      }
      map[stt] = columns[3];
    }
  }
  return map;
}

module.exports = { parseGradedTable };
