/**
 * Lesson-tab → exercise-table index mapping.
 *
 * Each Google Doc tab ("BUỔI XX") contains several tables; `tableIndex` lists
 * the indexes of the tables holding the part-IV exercises. The last index is
 * the table that contains the teacher's overall feedback.
 *
 * Pure. The backend copies this file verbatim into
 * auto-check-exercise-be/backend/lib/doc/ to run grading jobs — see the header
 * of docWriter.js.
 */
/**
 * Cần gạt thoát hiểm cho `docTableDetect`: ép cứng chỉ số bảng cho một tab cụ
 * thể, dùng khi tài liệu của một lớp nào đó dị dạng tới mức việc nhận diện
 * theo header không ra đúng. Bình thường để RỖNG — nhận diện theo nội dung là
 * đường chính, và một fallback tự động sẽ kích hoạt đúng vào lúc bố cục đã
 * trôi, tức đúng lúc chỉ số cứng sai nhất.
 *
 * @type {Array<{tabName: string, classType?: string, tableIndex: number[]}>}
 */
export const TABLE_OVERRIDES = [];

export const CLASS_TYPE_BASIC_SINCE_01042026 = "basic_since_01042026";
export const CLASS_TYPE_BASIC_BEFORE_31032026 = "basic_before_31032026";
export const CLASS_TYPE_BASIC_SINCE_20072026 = "basic_since_20072026";

export const TAB_NAME_LIST = [
  { tableIndex: [5, 6], tabName: "BUỔI 02" },
  { tableIndex: [5, 6], tabName: "BUỔI 03" },
  { tableIndex: [5, 6, 7, 8, 9], tabName: "BUỔI 04" },
  { tableIndex: [5, 6, 7, 8], tabName: "BUỔI 05" },
  { tableIndex: [7, 8, 9, 10], tabName: "BUỔI 09" },
  { tableIndex: [7, 8], tabName: "BUỔI 10" },
  { tableIndex: [7, 8], tabName: "BUỔI 11" },
  { tableIndex: [7, 8], tabName: "BUỔI 12" },
  { tableIndex: [7, 8], tabName: "BUỔI 13" },
  { tableIndex: [7, 8], tabName: "BUỔI 14" },
  { tableIndex: [7, 8], tabName: "BUỔI 15" },
  { tableIndex: [7, 8], tabName: "BUỔI 16" },
  { tableIndex: [7, 8], tabName: "BUỔI 17" },
  { tableIndex: [7, 8], tabName: "BUỔI 18" },
  { tableIndex: [7, 8], tabName: "BUỔI 21" },
  { tableIndex: [7, 8], tabName: "BUỔI 22" },
  { tableIndex: [7, 8], tabName: "BUỔI 23" },
];

export const TAB_NAME_LIST_FOR_BASIC_CLASS_BEFORE_31032026 = [
  { tableIndex: [4, 5], tabName: "BUỔI 02" },
  { tableIndex: [4], tabName: "BUỔI 03" },
  { tableIndex: [3, 4, 5, 6, 7, 8], tabName: "BUỔI 04" },
  { tableIndex: [4, 5, 6, 7, 8], tabName: "BUỔI 05" },
  { tableIndex: [6, 7, 8, 9], tabName: "BUỔI 09" },
  { tableIndex: [6, 7], tabName: "BUỔI 10" },
  { tableIndex: [6, 7], tabName: "BUỔI 11" },
  { tableIndex: [6, 7], tabName: "BUỔI 12" },
  { tableIndex: [6, 7], tabName: "BUỔI 13" },
  { tableIndex: [6, 7], tabName: "BUỔI 14" },
  { tableIndex: [6, 7], tabName: "BUỔI 15" },
  { tableIndex: [6, 7], tabName: "BUỔI 16" },
  { tableIndex: [6, 7], tabName: "BUỔI 17" },
  { tableIndex: [6], tabName: "BUỔI 18" },
  { tableIndex: [6], tabName: "BUỔI 21" },
  { tableIndex: [6], tabName: "BUỔI 22" },
  { tableIndex: [6], tabName: "BUỔI 23" },
];

/** Resolves the exercise-table indexes for a tab, based on the class type. */
export function getTableIndexOfExercise(tabName, classType) {
  let foundTab;
  if (
    [CLASS_TYPE_BASIC_SINCE_01042026, CLASS_TYPE_BASIC_SINCE_20072026].includes(
      classType,
    )
  ) {
    foundTab = TAB_NAME_LIST.find((item) => tabName.includes(item.tabName));
  } else if (classType === CLASS_TYPE_BASIC_BEFORE_31032026) {
    foundTab = TAB_NAME_LIST_FOR_BASIC_CLASS_BEFORE_31032026.find((item) =>
      tabName.includes(item.tabName),
    );
  }
  return foundTab ? foundTab.tableIndex : null;
}
