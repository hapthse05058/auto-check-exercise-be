// Pure billing math for the admin saler-commission panel. No Firestore/IO here so
// it can be unit-tested directly (see backend/tests/billing.test.js). The website
// mirrors these functions in src/lib/billing.js — keep both in sync.

/** VND per grading point (1 point = 700đ). */
const VND_PER_POINT = 700;
/** Saler commission per point, in VND. */
const COMMISSION_VND_PER_POINT = 100;

/** Total saler commission earned on a topped-up amount: round(total / 700 * 100). */
function salerCostVnd(totalTopUpVnd) {
  const total = Number(totalTopUpVnd) || 0;
  return Math.round((total / VND_PER_POINT) * COMMISSION_VND_PER_POINT);
}

/**
 * Commission not yet settled: the saler cost on the top-ups accrued since the
 * last settlement (`total - settled`, clamped at 0).
 */
function outstandingCommissionVnd(totalTopUpVnd, settledTopUpVnd) {
  const total = Number(totalTopUpVnd) || 0;
  const settled = Number(settledTopUpVnd) || 0;
  return salerCostVnd(Math.max(0, total - settled));
}

/** Sum of commission paid across all settlement-history entries. */
function sumPaidCommissionVnd(history) {
  if (!Array.isArray(history)) return 0;
  return history.reduce((sum, h) => sum + (Number(h?.commissionVnd) || 0), 0);
}

/** Net revenue kept after paying the saler: total topped up minus commission already paid. */
function netRevenueVnd(totalTopUpVnd, paidCommissionVnd) {
  const total = Number(totalTopUpVnd) || 0;
  const paid = Number(paidCommissionVnd) || 0;
  return total - paid;
}

module.exports = {
  VND_PER_POINT,
  COMMISSION_VND_PER_POINT,
  salerCostVnd,
  outstandingCommissionVnd,
  sumPaidCommissionVnd,
  netRevenueVnd,
};
