// Pure billing math for the admin revenue panel. No Firestore/IO here so it can
// be unit-tested directly (see backend/tests/billing.test.js). The website mirrors
// this in src/lib/billing.js — keep both in sync.

/** VND per grading point (1 point = 600đ). */
const VND_PER_POINT = 600;
/** Saler commission per point, in VND. */
const COMMISSION_VND_PER_POINT = 100;

/**
 * Saler commission earned on a topped-up amount: round(total / 600 * 100) = total/6.
 * Display-only — the saler takes this upfront; it does not reduce the admin's revenue.
 */
function salerCostVnd(totalTopUpVnd) {
  const total = Number(totalTopUpVnd) || 0;
  return Math.round(total / 6);
}

module.exports = {
  VND_PER_POINT,
  COMMISSION_VND_PER_POINT,
  salerCostVnd,
};
