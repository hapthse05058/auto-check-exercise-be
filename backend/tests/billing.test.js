const { test } = require("node:test");
const assert = require("node:assert/strict");
const { salerCostVnd, VND_PER_POINT } = require("../lib/billing.js");

test("VND_PER_POINT is 600 (60.000đ → 100 points)", () => {
  assert.equal(VND_PER_POINT, 600);
  assert.equal(60000 / VND_PER_POINT, 100);
});

test("salerCostVnd: one top-up step (60000) → 10000", () => {
  assert.equal(salerCostVnd(60000), 10000);
});

test("salerCostVnd: zero / falsy → 0", () => {
  assert.equal(salerCostVnd(0), 0);
  assert.equal(salerCostVnd(undefined), 0);
  assert.equal(salerCostVnd(null), 0);
});

test("salerCostVnd: is total/6, rounded to nearest VND", () => {
  // 1000 / 600 * 100 = 166.67 → 167
  assert.equal(salerCostVnd(1000), 167);
  // 600000 / 6 = 100000 exactly
  assert.equal(salerCostVnd(600000), 100000);
});
