const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  PRICE_AUTO_VND,
  PRICE_MANUAL_VND,
  TOPUP_STEP_VND,
  balanceVndOf,
  formatVnd,
  isValidTopUp,
  revenueOfTopUp,
  salerCostVnd,
  unitPriceOfJob,
} = require("../lib/billing.js");
const { consumePointsForDocs } = require("../lib/teacherPoints.js");
const {
  FakeFirestore,
  createFakeAdmin,
} = require("./helpers/fakeFirestore.js");

test("prices: 800đ by hand, 700đ for a scheduled run", () => {
  assert.equal(PRICE_MANUAL_VND, 800);
  assert.equal(PRICE_AUTO_VND, 700);
  assert.equal(unitPriceOfJob({ origin: null }), 800);
  assert.equal(unitPriceOfJob({ origin: { type: "schedule" } }), 700);
  // The price stored on the job wins over its origin.
  assert.equal(
    unitPriceOfJob({ origin: { type: "schedule" }, unitPriceVnd: 700 }),
    700,
  );
});

describe("balanceVndOf", () => {
  test("a record from before VND: point × 700", () => {
    assert.equal(balanceVndOf({ point: 100 }), 70000);
    assert.equal(balanceVndOf({ point: 0 }), 0);
  });
  test("balanceVnd wins once stored, even 0", () => {
    assert.equal(balanceVndOf({ point: 100, balanceVnd: 1500 }), 1500);
    assert.equal(balanceVndOf({ point: 100, balanceVnd: 0 }), 0);
  });
  test("no record → 0", () => {
    assert.equal(balanceVndOf(undefined), 0);
    assert.equal(balanceVndOf({}), 0);
  });
});

describe("top-up", () => {
  test("only whole multiples of 70.000đ, 70k..7M", () => {
    assert.equal(TOPUP_STEP_VND, 70000);
    assert.ok(isValidTopUp(70000));
    assert.ok(isValidTopUp(140000));
    assert.ok(isValidTopUp(7000000));
    assert.ok(!isValidTopUp(0));
    assert.ok(!isValidTopUp(60000));
    assert.ok(!isValidTopUp(100000));
    assert.ok(!isValidTopUp(7070000));
    assert.ok(!isValidTopUp(70000.5));
  });
  test("revenue is 6/7 of the amount (≈ 0.85714)", () => {
    assert.equal(revenueOfTopUp(70000), 60000);
    assert.equal(revenueOfTopUp(700000), 600000);
    assert.equal(revenueOfTopUp(0), 0);
  });
  test("saler commission is revenue / 6 (= amount / 7)", () => {
    assert.equal(salerCostVnd(60000), 10000);
    assert.equal(salerCostVnd(revenueOfTopUp(140000)), 20000);
    assert.equal(salerCostVnd(undefined), 0);
  });
});

test("formatVnd groups thousands with dots", () => {
  assert.equal(formatVnd(800), "800đ");
  assert.equal(formatVnd(70000), "70.000đ");
  assert.equal(formatVnd(1234567), "1.234.567đ");
  assert.equal(formatVnd(-1600), "-1.600đ");
  assert.equal(formatVnd(undefined), "0đ");
});

describe("consumePointsForDocs in VND", () => {
  const payer = { id: "t1", gmail: "t@x.com", name: "T" };
  const setup = (data) => {
    const db = new FakeFirestore();
    db._apply({ type: "set", path: "TeacherPoint/t1", data });
    const read = () => db.dump("TeacherPoint").t1;
    const charge = (docIds, unitPriceVnd) =>
      consumePointsForDocs(db, createFakeAdmin(), {
        payer,
        docIds,
        classId: "c1",
        lessonId: "l1",
        chargedByEmail: "t@x.com",
        unitPriceVnd,
      });
    return { db, read, charge };
  };

  test("converts a legacy balance on the first charge", async () => {
    const { read, charge } = setup({ point: 10 });
    const out = await charge(["d1", "d2"], 800);
    assert.deepEqual(out, { balanceVnd: 5400, charged: 2, chargedVnd: 1600 });
    assert.equal(read().balanceVnd, 5400, "7000 − 2 × 800");
  });

  test("refuses what the balance cannot cover, charging nothing", async () => {
    const { db, read, charge } = setup({ balanceVnd: 1000 });
    const out = await charge(["d1", "d2"], 700);
    assert.equal(out.charged, 0);
    assert.equal(out.need, 2);
    assert.equal(out.needVnd, 1400);
    assert.equal(read().balanceVnd, 1000);
    assert.equal(Object.keys(db.dump("TeacherPointLedger")).length, 0);
  });

  test("the receipt records the price paid", async () => {
    const { db, charge } = setup({ balanceVnd: 5000 });
    await charge(["d1"], 800);
    const [receipt] = Object.values(db.dump("TeacherPointLedger"));
    assert.equal(receipt.amountVnd, 800);
  });

  test("a price is required", async () => {
    const { charge } = setup({ balanceVnd: 5000 });
    await assert.rejects(charge(["d1"], undefined), /unitPriceVnd/);
  });
});
