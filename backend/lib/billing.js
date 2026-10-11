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

/**
 * A top-up is any whole number of đ in [1.000đ, 10.000.000đ] — what the
 * teacher actually paid. The ceiling only catches a mistyped extra zero.
 */
const TOPUP_MIN_VND = 1000;
const TOPUP_MAX_VND = 10000000;

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

/** Validates a top-up amount: a whole number of đ within [1.000đ, 10M]. */
function isValidTopUp(amountVnd) {
  return (
    Number.isInteger(amountVnd) &&
    amountVnd >= TOPUP_MIN_VND &&
    amountVnd <= TOPUP_MAX_VND
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

/**
 * "25 bài × 800đ = 20.000đ": what a charge (or a shortfall) is made of, for
 * the notifications. Points were one per doc; in VND the teacher needs the
 * sum spelled out.
 */
function costFormula(docs, unitPriceVnd) {
  const n = Math.max(0, Math.floor(Number(docs) || 0));
  const price = Math.round(Number(unitPriceVnd) || 0);
  return `${n} bài × ${formatVnd(price)} = ${formatVnd(n * price)}`;
}

/**
 * The money sentence closing a "grading finished" notification:
 * "Đã trừ 25 bài × 800đ = 20.000đ." — plus the docs an earlier receipt had
 * already paid for, or "Không trừ tiền." when nothing was charged.
 */
function chargeSentence({ charged, alreadyPaid, unitPriceVnd }) {
  const parts = [];
  if (charged > 0) {
    parts.push(`Đã trừ ${costFormula(charged, unitPriceVnd)}.`);
  }
  if (alreadyPaid > 0) {
    parts.push(`${alreadyPaid} bài đã trả tiền trước đó nên không trừ lại.`);
  }
  return parts.length ? parts.join(" ") : "Không trừ tiền.";
}

module.exports = {
  PRICE_MANUAL_VND,
  PRICE_AUTO_VND,
  LEGACY_VND_PER_POINT,
  TOPUP_MIN_VND,
  TOPUP_MAX_VND,
  balanceVndOf,
  unitPriceOfJob,
  isValidTopUp,
  revenueOfTopUp,
  salerCostVnd,
  formatVnd,
  costFormula,
  chargeSentence,
};
