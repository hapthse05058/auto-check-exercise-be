/**
 * Synthetic SEC LMS data, shaped exactly like the LMS's own responses
 * (GET .../grading/{studentId}/assignment, the session score report) but with
 * invented names and answers — no real student data is committed.
 *
 * Also a stateful fake LMS: saveDraft applies a PUT body to the stored page
 * the way the LMS does, so a re-read sees the draft.
 */
let seq = 0;
const nextId = () => {
  seq += 1;
  return `17900000${String(seq).padStart(5, "0")}-${seq}`;
};

/** A tiptap doc string, one paragraph per line. */
function doc(text) {
  return JSON.stringify({
    type: "doc",
    content: String(text)
      .split("\n")
      .map((line) =>
        line
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
  });
}

const textContent = (text) => [
  { id: nextId(), type: 0, source: doc(text), subContent: null },
];

function heading(text) {
  return {
    id: nextId(),
    serialNumber: 0,
    type: 3,
    content: textContent(text),
    review: "",
    selectedAnswer: [],
    gradedAt: null,
    gradingLateFlag: null,
    score: 1,
    inputType: [0],
  };
}

/** An ESSAY question; `answer: null` = not answered. */
function essay(serialNumber, question, answer, opts = {}) {
  return {
    id: opts.id || nextId(),
    serialNumber,
    type: 2,
    content: opts.content || textContent(question),
    review: opts.review ?? "",
    selectedAnswer:
      answer === null
        ? []
        : [
            {
              id: nextId(),
              content: textContent(answer),
              isCorrect: opts.isCorrect ?? null,
            },
          ],
    gradedAt: opts.gradedAt ?? null,
    gradingLateFlag: opts.gradingLateFlag ?? null,
    score: 1,
    inputType: [0],
  };
}

function mcq(serialNumber, correct) {
  return {
    id: nextId(),
    serialNumber,
    type: 0,
    content: textContent(`Câu trắc nghiệm ${serialNumber}`),
    review: "",
    selectedAnswer: [
      { id: nextId(), content: textContent("B"), isCorrect: correct ? 1 : 0 },
    ],
    gradedAt: null,
    gradingLateFlag: null,
    score: 1,
    inputType: [0],
  };
}

function assignment({
  assignmentId,
  name,
  groups,
  gradingStatus = 4,
  checkDeadline = "2026-11-12T21:44:50.888318",
  score = 0,
  review = null,
}) {
  return {
    assignmentId,
    assignmentLogId: assignmentId * 10,
    name,
    time: 60,
    type: 1,
    gradingList: {
      id: String(assignmentId),
      name: "Phần mới",
      questionGroupList: groups.map((g) => ({
        id: nextId(),
        serialNumber: 1,
        title: g.title ? textContent(g.title) : [],
        questionGroup: [
          {
            id: nextId(),
            serialNumber: 1,
            name: "",
            content: [],
            questionList: g.rows,
          },
        ],
      })),
    },
    review,
    score,
    inputType: 0,
    checkDeadline,
    gradingStatus,
    classId: 7,
    sessionId: 477,
  };
}

/**
 * A KTN session page: VIẾT CÂU (formula group + 2 headed groups), SẮP XẾP,
 * CHÍNH TẢ and TRẮC NGHIỆM. `answers` overrides the five translation answers.
 */
function sessionPage({
  answers = [
    "I study English every day good",
    "She reads books every night good",
    "I am studying English now",
    "a computer - two computers good",
    null,
  ],
  writingStatus = 4,
  writingReview = {},
  orderingAnswer = "Long speaks clearly.",
  spellingAnswer = "stories good",
} = {}) {
  const ids = ["q-w1", "q-w2", "q-w3", "q-w4", "q-w5"];
  const writing = assignment({
    assignmentId: 1472,
    name: "BÀI TẬP VIẾT CÂU",
    gradingStatus: writingStatus,
    groups: [
      {
        rows: [
          heading(
            "Cả lớp dựa vào từ vựng gợi ý, chuyển câu tiếng Việt sang câu tiếng Anh",
          ),
        ],
      },
      {
        title: "Thành lập các thì sau theo 2 bước",
        rows: [
          essay(1, "HTĐ", "V(s/es)", { id: "q-f1" }),
          essay(2, "HTTD\nB1:\nB2:", "Be + Ving", { id: "q-f2" }),
        ],
      },
      {
        title: "Dịch câu tiếng Việt sang tiếng Anh",
        rows: [
          heading("HTĐ"),
          essay(3, "Tôi học Tiếng Anh hàng ngày.", answers[0], {
            id: ids[0],
            review: writingReview[ids[0]],
          }),
          essay(4, "Cô ấy đọc sách mỗi tối.", answers[1], {
            id: ids[1],
            review: writingReview[ids[1]],
          }),
          heading("HTTD"),
          essay(5, "Tôi đang học Tiếng Anh bây giờ.", answers[2], {
            id: ids[2],
            review: writingReview[ids[2]],
          }),
          heading("DANH TỪ SỐ ÍT SANG SỐ NHIỀU"),
          essay(6, "Một chiếc máy tính - 2 chiếc máy tính", answers[3], {
            id: ids[3],
            review: writingReview[ids[3]],
          }),
          essay(7, "Cát", answers[4], {
            id: ids[4],
            review: writingReview[ids[4]],
          }),
        ],
      },
    ],
  });
  const ordering = assignment({
    assignmentId: 1473,
    name: "BÀI TẬP SẮP XẾP TỪ THÀNH CÂU ĐÚNG",
    gradingStatus: 4,
    groups: [
      {
        rows: [
          essay(1, "speaks / Long / clearly / .", orderingAnswer, {
            id: "q-o1",
          }),
        ],
      },
    ],
  });
  const spelling = assignment({
    assignmentId: 1474,
    name: "BÀI TẬP CHÍNH TẢ",
    gradingStatus: 4,
    groups: [
      {
        title:
          "QUY TẮC 2: PHỤ ÂM + Y → IES\nCâu hỏi: Hãy thêm “s/es” vào các từ sau:",
        rows: [essay(1, "story", spellingAnswer, { id: "q-s1" })],
      },
    ],
  });
  // An essay assignment the tool never grades, already graded by the teacher.
  const listening = assignment({
    assignmentId: 1476,
    name: "BÀI TẬP NGHE",
    gradingStatus: 4,
    groups: [
      {
        rows: [
          essay(1, "Nghe và chép lại", "I go to school.", {
            id: "q-l1",
            review: doc("Tốt"),
            isCorrect: 1,
            gradedAt: "2026-11-05T10:00:00",
          }),
        ],
      },
    ],
  });
  const quiz = assignment({
    assignmentId: 1475,
    name: "BÀI TẬP TRẮC NGHIỆM",
    gradingStatus: 0,
    groups: [{ rows: [mcq(1, true), mcq(2, false)] }],
  });
  return [writing, ordering, spelling, listening, quiz];
}

/**
 * A score-report row (GET .../assignment-score-report). `null` status = not
 * submitted. By default the student submitted writing and word order, not
 * spelling.
 */
function reportRow(
  studentId,
  fullName,
  writingStatus,
  { ordering = 4, spelling = null } = {},
) {
  return {
    id: studentId,
    studentId,
    fullName,
    scoreReportList: [
      {
        assignmentId: 1472,
        assignmentName: "BÀI TẬP VIẾT CÂU",
        questionType: 1,
        gradingStatus: writingStatus,
      },
      {
        assignmentId: 1473,
        assignmentName: "BÀI TẬP SẮP XẾP TỪ THÀNH CÂU ĐÚNG",
        questionType: 1,
        gradingStatus: ordering,
      },
      {
        assignmentId: 1474,
        assignmentName: "BÀI TẬP CHÍNH TẢ",
        questionType: 1,
        gradingStatus: spelling,
      },
      {
        assignmentId: 1476,
        assignmentName: "BÀI TẬP NGHE",
        questionType: 1,
        gradingStatus: 4,
      },
      {
        assignmentId: 1475,
        assignmentName: "BÀI TẬP TRẮC NGHIỆM",
        questionType: 0,
        gradingStatus: 0,
      },
    ],
  };
}

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

/** Applies a "Lưu nháp" body to a stored page, as the LMS does. */
function applyDraft(page, body) {
  for (const entry of body) {
    const a = page.find((x) => x.assignmentId === entry.assignmentId);
    if (!a) continue;
    a.score = entry.score;
    a.review = entry.review;
    const reviews = new Map(
      entry.questionReviews.map((r) => [r.questionId, r]),
    );
    for (const g of a.gradingList.questionGroupList) {
      for (const qg of g.questionGroup) {
        for (const q of qg.questionList) {
          const r = reviews.get(q.id);
          if (!r) continue;
          q.review = r.review;
          q.gradedAt = r.gradedAt;
          q.gradingLateFlag = r.gradingLateFlag;
          if (q.selectedAnswer?.[0])
            q.selectedAnswer[0].isCorrect = r.isCorrect;
        }
      }
    }
  }
}

/**
 * Fake teacher API (lmsClient.forTeacher(...) shape) over in-memory pages.
 * `hooks.beforePut(studentId, body)` / `afterPut(studentId)` let tests inject
 * a teacher edit or a lost response.
 */
function createFakeLms({ rows, pages, classes, sessions, hooks = {} }) {
  const { LmsError } = require("../../lib/lms/lmsClient.js");
  const state = {
    rows,
    pages: new Map(Object.entries(pages).map(([k, v]) => [String(k), v])),
    puts: [],
    reads: 0,
  };
  const api = {
    async listClasses() {
      return deepCopy(
        classes || [
          {
            id: 7,
            code: "KTN748N",
            courseCode: "KTN",
            courseName: "Kiến thức nền",
            sessionQuantity: 24,
          },
          { id: 9, code: "IELTS101", courseCode: "IELTS", courseName: "IELTS" },
        ],
      );
    },
    async listSessions() {
      return deepCopy(
        sessions || [
          {
            id: 477,
            sessionName: "Buổi học 4",
            startTime: "2026-11-01T20:00:00",
            checkDeadline: "2026-11-12 21:44:50",
          },
          {
            id: 478,
            sessionName: "Buổi học 5",
            startTime: "2099-01-01T20:00:00",
          },
        ],
      );
    },
    async listSubmissions() {
      return deepCopy(state.rows);
    },
    async getGrading(classId, sessionId, studentId) {
      state.reads += 1;
      const page = state.pages.get(String(studentId));
      if (!page) throw new LmsError("not_found", { status: 404 });
      return deepCopy(page);
    },
    async submitGrading(classId, sessionId, studentId, body) {
      state.submits = (state.submits || 0) + 1;
      state.puts.push({
        studentId: String(studentId),
        body: deepCopy(body),
        submit: true,
      });
      const page = state.pages.get(String(studentId));
      applyDraft(page, body);
      for (const a of page) a.gradingStatus = 2;
      return null;
    },
    async saveDraft(classId, sessionId, studentId, body) {
      await hooks.beforePut?.(String(studentId), body, state);
      state.puts.push({ studentId: String(studentId), body: deepCopy(body) });
      applyDraft(state.pages.get(String(studentId)), body);
      await hooks.afterPut?.(String(studentId), body, state);
      return null;
    },
  };
  return { api, state };
}

module.exports = {
  applyDraft,
  assignment,
  createFakeLms,
  deepCopy,
  doc,
  essay,
  heading,
  mcq,
  reportRow,
  sessionPage,
  textContent,
};
