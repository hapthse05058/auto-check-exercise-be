/**
 * Charging for graded docs. Moved out of server.js so the rule that matters
 * most here — a doc is never billed twice, however often the charge is retried
 * or raced — can be tested against the real code.
 */
const crypto = require("crypto");

const { normalizeForKey } = require("./gradingKey.js");

/**
 * Deterministic TeacherPointLedger document id — the receipt for one student
 * doc. Keyed on payer + doc + lesson so charging the same doc twice (a retry,
 * a re-run) is a no-op instead of a double charge.
 */
function pointLedgerId(payerTeacherId, docId, lessonId) {
  const raw = `${payerTeacherId}|${normalizeForKey(docId)}|${normalizeForKey(lessonId)}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

/**
 * Spends 1 point per student doc whose feedback was just written.
 *
 * The client sends the docs it has finished, NOT an amount: what those docs
 * cost is the server's decision. Each doc gets a TeacherPointLedger receipt
 * keyed by pointLedgerId(), and only docs without one are billable — so a
 * retry (whole or partial) settles exactly what is still owed and never
 * double-charges. The balance check and the debit share one transaction, which
 * is what keeps the balance from going negative.
 *
 * Shared by /teacher-points/consume and background grading jobs, which charge
 * one doc at a time right after writing it — a retried job step therefore
 * settles through the very same receipts and can never bill a doc twice.
 *
 * `jobId` (grading jobs only) is written onto each receipt, so a retried job
 * step that gets `charged: 0` back can tell "I charged this doc before I
 * crashed" from "someone else already paid for it".
 *
 * @returns {Promise<{point: number, charged: number, need?: number}>} `need`
 *   is set (and nothing charged) when the balance cannot cover the docs.
 */
async function consumePointsForDocs(
  db,
  admin,
  { payer, docIds, classId, lessonId, chargedByEmail, jobId = null },
) {
  lessonId = lessonId || null;
  const pointRef = db.collection("TeacherPoint").doc(payer.id);
  const ledgerRefs = docIds.map((docId) =>
    db
      .collection("TeacherPointLedger")
      .doc(pointLedgerId(payer.id, docId, lessonId)),
  );

  return db.runTransaction(async (tx) => {
    // Every read must happen before the first write in a transaction.
    const ledgerSnaps = await tx.getAll(...ledgerRefs);
    const pointSnap = await tx.get(pointRef);
    const current = pointSnap.exists ? (pointSnap.data().point ?? 0) : 0;

    const billable = docIds.filter((_, i) => !ledgerSnaps[i].exists);
    if (!billable.length) return { point: current, charged: 0 };
    if (current < billable.length) {
      return { point: current, charged: 0, need: billable.length };
    }

    // set+merge with increment also covers "no record yet", so there is no
    // read-then-create race between two concurrent charges.
    tx.set(
      pointRef,
      {
        teacherId: payer.id,
        gmail: payer.gmail || "",
        name: payer.name || "",
        point: admin.firestore.FieldValue.increment(-billable.length),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    billable.forEach((docId) => {
      tx.set(
        db
          .collection("TeacherPointLedger")
          .doc(pointLedgerId(payer.id, docId, lessonId)),
        {
          payerTeacherId: payer.id,
          classId: classId || null,
          docId,
          lessonId,
          chargedByEmail,
          jobId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      );
    });
    return { point: current - billable.length, charged: billable.length };
  });
}

module.exports = { consumePointsForDocs, pointLedgerId };
