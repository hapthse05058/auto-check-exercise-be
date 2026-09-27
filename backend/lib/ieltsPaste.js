/**
 * The website's "Chấm IELTS Writing" page: grade ONE pasted submission and
 * charge for it. Split out of server.js so the billing rules can be tested
 * against the real code.
 *
 * Billing is Basic's, reused as is (lib/teacherPoints.js): one receipt per
 * payer + "doc", where the doc is the submission itself (pasteReceiptDocId =
 * task + prompt + essay + charts). So:
 *   - the same teacher grading the same submission again pays nothing more;
 *   - another teacher pays once, even when the result comes from the cache —
 *     like Basic, a delivered result is what is paid for, not the AI call;
 *   - the balance is checked BEFORE the model is called, and the point is
 *     taken only AFTER a valid result exists: a failed grading costs nothing.
 */
const { pasteReceiptDocId } = require("./ieltsWriting.js");
const { pointLedgerId } = require("./teacherPoints.js");

class PasteError extends Error {
  constructor(status, code, params = null) {
    super(code);
    this.name = "PasteError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/**
 * @param deps.db
 * @param deps.grader         createIeltsGrader(...) result
 * @param deps.consumePoints  ({payer, docIds, classId, lessonId, chargedByEmail})
 * @param input               validateRequest(...) result
 * @returns {Promise<{result, feedback, cached, charged, point}>}
 * @throws {PasteError} 402 insufficient_points; IeltsError from the grader
 */
async function gradePasted(
  { db, grader, consumePoints },
  { payer, input, classId = null, email, useCache = true, requestId },
) {
  const receiptDocId = pasteReceiptDocId(input);
  const receipt = await db
    .collection("TeacherPointLedger")
    .doc(pointLedgerId(payer.id, receiptDocId, null))
    .get();
  if (!receipt.exists) {
    const snap = await db.collection("TeacherPoint").doc(payer.id).get();
    const point = snap.exists ? (snap.data().point ?? 0) : 0;
    if (point < 1) {
      throw new PasteError(402, "insufficient_points", { point, need: 1 });
    }
  }

  const graded = await grader.grade(input, { useCache, requestId });

  const charge = await consumePoints({
    payer,
    docIds: [receiptDocId],
    classId,
    lessonId: null,
    chargedByEmail: email,
  });
  if (charge.need) {
    // Only a concurrent spend lands here: the balance was checked above.
    throw new PasteError(402, "insufficient_points", {
      point: charge.point,
      need: 1,
    });
  }
  return { ...graded, charged: charge.charged, point: charge.point };
}

module.exports = { PasteError, gradePasted };
