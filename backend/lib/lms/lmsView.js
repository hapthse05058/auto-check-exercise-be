/**
 * Read-only views of SEC LMS data for the teacher, so a class can be looked
 * over without the LMS's own screens (which hide work after "Chi tiết" and
 * cannot reopen older sessions):
 *
 *   overviewRow(row)       one student's assignments in a session's score
 *                          report → status / score per assignment
 *   studentWork(grading)   one student's grading page → every assignment with
 *                          its questions, answers, reviews and marks
 *
 * Pure functions: no network, no Firestore.
 */
const L = require("./lmsItems.js");

/** Where one assignment of one student stands. */
const WORK_STATUS = Object.freeze({
  NOT_SUBMITTED: "notSubmitted",
  SUBMITTED: "submitted", // handed in, not marked yet (drafts included)
  GRADED: "graded", // the teacher pressed "Lưu & Chấm bài"
});

function workStatus(gradingStatus) {
  if (gradingStatus === null || gradingStatus === undefined) {
    return WORK_STATUS.NOT_SUBMITTED;
  }
  if (
    gradingStatus === L.GRADING_STATUS.COMPLETED ||
    gradingStatus === L.GRADING_STATUS.LATE
  ) {
    return WORK_STATUS.GRADED;
  }
  return WORK_STATUS.SUBMITTED;
}

const num = (v) =>
  Number.isFinite(Number(v)) && v !== null ? Number(v) : null;

/** One student's row of a session's score report. */
function overviewRow(row) {
  return {
    studentId: String(row?.studentId ?? ""),
    fullName: row?.fullName || "",
    assignments: (row?.scoreReportList || []).map((a) => ({
      assignmentId: a.assignmentId,
      name: a.assignmentName || "",
      kind: L.assignmentKind({ name: a.assignmentName }),
      mcq: a.questionType === 0,
      status: workStatus(a.gradingStatus),
      gradingStatus: a.gradingStatus ?? null,
      score: num(a.score),
    })),
  };
}

/** 1 → true, 0 → false, anything else (unmarked) → null. */
function markOf(question) {
  const v = question?.selectedAnswer?.[0]?.isCorrect;
  if (v === 1 || v === true) return true;
  if (v === 0 || v === false) return false;
  return null;
}

/** One student's grading page, every assignment, for reading. */
function studentWork(grading) {
  return (Array.isArray(grading) ? grading : []).map((assignment) => {
    const kind = L.assignmentKind(assignment);
    const questions = L.walkQuestions(assignment).map(
      ({ question, groupTitle, heading }) => {
        const prompt = L.contentText(question.content);
        const { cls } = L.classifyQuestion(
          { question, groupTitle, heading },
          kind,
        );
        const section = L.firstLine(heading) || L.firstLine(groupTitle);
        return {
          id: question.id,
          key: L.questionKey(assignment.assignmentId, question.id),
          // The questions a teacher marks; only these have reviews on the LMS.
          editable: question.type === L.QUESTION_TYPE.ESSAY,
          // What the 1-5 suggestion counts (blanks and formula rows do not).
          counted: Boolean(kind) && cls === L.QUESTION_CLASS.SUPPORTED,
          serialNumber: question.serialNumber ?? null,
          section,
          question: prompt.text,
          hasMedia: prompt.hasMedia,
          answer: L.answerText(question),
          review: L.tiptapToText(question.review, { markBold: true }),
          // Marked by someone (teacher or tool draft): only then is
          // isCorrect a verdict — an untouched row carries 0 too.
          graded: Boolean(question.gradedAt),
          isCorrect: markOf(question),
        };
      },
    );
    return {
      assignmentId: assignment.assignmentId,
      name: assignment.name || "",
      kind,
      status: workStatus(assignment.gradingStatus),
      gradingStatus: assignment.gradingStatus ?? null,
      score: num(assignment.score),
      review: L.tiptapToText(assignment.review, { markBold: true }),
      submittedAt: assignment.createdAt || null,
      questions,
    };
  });
}

module.exports = { WORK_STATUS, overviewRow, studentWork, workStatus };
