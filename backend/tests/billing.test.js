const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  salerCostVnd,
  outstandingCommissionVnd,
  sumPaidCommissionVnd,
  netRevenueVnd,
} = require("../lib/billing.js");

test("salerCostVnd: one top-up step (70000) → 10000", () => {
  assert.equal(salerCostVnd(70000), 10000);
});

test("salerCostVnd: zero / falsy → 0", () => {
  assert.equal(salerCostVnd(0), 0);
  assert.equal(salerCostVnd(undefined), 0);
  assert.equal(salerCostVnd(null), 0);
});

test("salerCostVnd: rounds to nearest VND", () => {
  // 1000 / 700 * 100 = 142.857… → 143
  assert.equal(salerCostVnd(1000), 143);
  // 4900 / 700 * 100 = 700 exactly
  assert.equal(salerCostVnd(4900), 700);
});

test("outstandingCommissionVnd: missing/zero settled → full cost", () => {
  assert.equal(outstandingCommissionVnd(70000, 0), 10000);
  assert.equal(outstandingCommissionVnd(70000, undefined), 10000);
});

test("outstandingCommissionVnd: settled === total → 0", () => {
  assert.equal(outstandingCommissionVnd(70000, 70000), 0);
});

test("outstandingCommissionVnd: settled > total clamps to 0", () => {
  assert.equal(outstandingCommissionVnd(70000, 140000), 0);
});

test("outstandingCommissionVnd: partial accrual since settlement", () => {
  // accrued 140000 - 70000 = 70000 → 10000 commission
  assert.equal(outstandingCommissionVnd(140000, 70000), 10000);
});

test("sumPaidCommissionVnd: empty / non-array → 0", () => {
  assert.equal(sumPaidCommissionVnd([]), 0);
  assert.equal(sumPaidCommissionVnd(undefined), 0);
});

test("sumPaidCommissionVnd: sums entries, ignoring bad values", () => {
  assert.equal(
    sumPaidCommissionVnd([
      { commissionVnd: 10000 },
      { commissionVnd: 5000 },
      { commissionVnd: undefined },
      {},
    ]),
    15000,
  );
});

test("netRevenueVnd: total minus paid commission", () => {
  assert.equal(netRevenueVnd(140000, 10000), 130000);
  assert.equal(netRevenueVnd(0, 0), 0);
});
