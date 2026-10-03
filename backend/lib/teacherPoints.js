/**
 * Charging for graded docs. Moved out of server.js so the rule that matters
 * most here — a doc is never billed twice, however often the charge is retried
 * or raced — can be tested against the real code.
 *
 * The collections keep their old names (TeacherPoint, TeacherPointLedger), but
 * the balance is money now: `balanceVnd`, see lib/billing.js.
 */
const crypto = require("crypto");

const { balanceVndOf } = require("./billing.js");
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

/** A teacher's balance in VND (0 when there is no record yet). */
async function readBalanceVnd(db, teacherId) {
  const snap = await db.collection("TeacherPoint").doc(teacherId).get();
  return snap.exists ? balanceVndOf(snap.data()) : 0;
}

/**
 * Charges `unitPriceVnd` per student doc whose feedback was just written
 * (lib/billing.js: 800đ by hand, 700đ for a scheduled run).
 *
 * The client sends the docs it has finished, NOT an amount: what those docs
 * cost is the server's decision. Each doc gets a TeacherPointLedger receipt
 * keyed by pointLedgerId(), and only docs without one are billable — so a
 * retry (whole or partial) settles exactly what is still owed and never
 * double-charges. The balance check and the debit share one transaction, which
 * is what keeps the balance from going negative.
 *
 * A record from before VND only has `point`; balanceVndOf converts it (× 700)
 * and the first charge stores `balanceVnd`. The debit therefore writes the new
 * value instead of an increment — safe, because the record was read in this
 * same transaction, so a concurrent write forces a retry.
 *
 * Shared by /teacher-points/consume and background grading jobs, which charge
 * one doc at a time right after writing it — a retried job step therefore
 * settles through the very same receipts and can never bill a doc twice.
 *
 * `jobId` (grading jobs only) is written onto each receipt, so a retried job
 * step that gets `charged: 0` back can tell "I charged this doc before I
 * crashed" from "someone else already paid for it".
 *
 * @returns {Promise<{balanceVnd: number, charged: number, chargedVnd: number,
 *   need?: number, needVnd?: number}>} `charged` and `need` count docs. `need`
 *   is set (and nothing charged) when the balance cannot cover the docs.
 */
async function consumePointsForDocs(
  db,
  admin,
  {
    payer,
    docIds,
    classId,
    lessonId,
    chargedByEmail,
    unitPriceVnd,
    jobId = null,
  },
) {
  if (!Number.isFinite(unitPriceVnd) || unitPriceVnd <= 0) {
    throw new Error("consumePointsForDocs: unitPriceVnd is required");
  }
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
    const current = pointSnap.exists ? balanceVndOf(pointSnap.data()) : 0;

    const billable = docIds.filter((_, i) => !ledgerSnaps[i].exists);
    if (!billable.length) {
      return { balanceVnd: current, charged: 0, chargedVnd: 0 };
    }
    const costVnd = billable.length * unitPriceVnd;
    if (current < costVnd) {
      return {
        balanceVnd: current,
        charged: 0,
        chargedVnd: 0,
        need: billable.length,
        needVnd: costVnd,
      };
    }

    // set+merge also covers "no record yet".
    tx.set(
      pointRef,
      {
        teacherId: payer.id,
        gmail: payer.gmail || "",
        name: payer.name || "",
        balanceVnd: current - costVnd,
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
          amountVnd: unitPriceVnd,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      );
    });
    return {
      balanceVnd: current - costVnd,
      charged: billable.length,
      chargedVnd: costVnd,
    };
  });
}

module.exports = { consumePointsForDocs, pointLedgerId, readBalanceVnd };
