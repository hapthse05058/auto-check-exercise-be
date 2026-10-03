// Pure billing math: grading prices, the teacher balance (in VND) and the admin
// revenue panel. No Firestore/IO here so it can be unit-tested directly (see
// backend/tests/billing.test.js). The website mirrors this in src/lib/billing.js
// — keep both in sync.

/** Price of one doc graded by hand (the grading screen, IELTS paste). */
const PRICE_MANUAL_VND = 800;
/** Price of one doc graded by a scheduled ("chấm tự động") run. */
const PRICE_AUTO_VND = 700;

/** A balance from before VND: 1 legacy point = 700đ (what a teacher paid). */
const LEGACY_VND_PER_POINT = 700;

/** Top-ups are whole multiples of 70.000đ, up to 100 steps. */
const TOPUP_STEP_VND = 70000;
const TOPUP_MAX_VND = 7000000;

/**
 * Share of a top-up that is the admin's revenue: 6/7 (≈ 0.85714). The other
 * 1/7 is the saler's commission, taken upfront — 70.000đ → 60.000đ revenue.
 */
const REVENUE_NUMERATOR = 6;
const REVENUE_DENOMINATOR = 7;

/**
 * A teacher's balance in VND, from a TeacherPoint record (or its data).
 * Records written before the switch only have `point`; they read as
 * point × 700 until their first charge/top-up stores `balanceVnd`.
 */
function balanceVndOf(data) {
  if (!data) return 0;
  if (Number.isFinite(data.balanceVnd)) return data.balanceVnd;
  return Math.round((Number(data.point) || 0) * LEGACY_VND_PER_POINT);
}

/** What one doc of a grading job costs: scheduled runs pay the auto price. */
function unitPriceOfJob(job) {
  if (Number.isFinite(job?.unitPriceVnd)) return job.unitPriceVnd;
  return job?.origin?.type === "schedule" ? PRICE_AUTO_VND : PRICE_MANUAL_VND;
}

/** Validates a top-up amount: integer multiple of 70k within [70k, 7M]. */
function isValidTopUp(amountVnd) {
  return (
    Number.isInteger(amountVnd) &&
    amountVnd >= TOPUP_STEP_VND &&
    amountVnd <= TOPUP_MAX_VND &&
    amountVnd % TOPUP_STEP_VND === 0
  );
}

/** Admin revenue from a top-up: amount × 6/7 (70.000đ → 60.000đ). */
function revenueOfTopUp(amountVnd) {
  const amount = Number(amountVnd) || 0;
  return Math.round((amount * REVENUE_NUMERATOR) / REVENUE_DENOMINATOR);
}

/**
 * Saler commission matching a revenue total: revenue / 6 (= top-up / 7).
 * Holds for the old points too — 60.000đ revenue per 100 points, 10.000đ to
 * the saler. Display-only: it does not reduce the admin's revenue.
 */
function salerCostVnd(totalRevenueVnd) {
  const total = Number(totalRevenueVnd) || 0;
  return Math.round(total / REVENUE_NUMERATOR);
}

/** 12345 → "12.345đ" (Vietnamese grouping, no locale data needed). */
function formatVnd(amountVnd) {
  const n = Math.round(Number(amountVnd) || 0);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${digits}đ`;
}

module.exports = {
  PRICE_MANUAL_VND,
  PRICE_AUTO_VND,
  LEGACY_VND_PER_POINT,
  TOPUP_STEP_VND,
  TOPUP_MAX_VND,
  balanceVndOf,
  unitPriceOfJob,
  isValidTopUp,
  revenueOfTopUp,
  salerCostVnd,
  formatVnd,
};
