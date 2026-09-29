const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  NOTIFICATION_SEARCH_SCAN_LIMIT,
  categoryOf,
  searchNotifications,
} = require("../lib/notifications.js");
const { FakeFirestore, Timestamp } = require("./helpers/fakeFirestore.js");

const ME = "teacher@example.com";
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-09-29T10:00:00Z");

/** Seeds notifications; `ago` is days before NOW. */
async function seed(rows) {
  const db = new FakeFirestore();
  for (const row of rows) {
    await db
      .collection("notifications")
      .doc(row.id)
      .set({
        type: row.type || "grading.jobDone",
        severity: row.severity || "INFO",
        title: row.id,
        body: "",
        data: {},
        recipients: row.recipients || [ME],
        readBy: row.read ? [ME] : [],
        createdAt: Timestamp.fromMillis(NOW - (row.ago || 0) * DAY),
      });
  }
  return db;
}

const ids = (result) => result.results.map((item) => item.id);

describe("categoryOf", () => {
  it("files grading.* under grading and the rest under system", () => {
    assert.equal(categoryOf("grading.autoDone"), "grading");
    assert.equal(categoryOf("deepseek.lowBalance"), "system");
    assert.equal(categoryOf(null), "system");
  });
});

describe("searchNotifications", () => {
  it("returns only the viewer's own notifications, newest first", async () => {
    const db = await seed([
      { id: "old", ago: 5 },
      { id: "new", ago: 0 },
      { id: "theirs", ago: 1, recipients: ["someone@else.com"] },
      { id: "mid", ago: 2 },
    ]);
    const result = await searchNotifications(db, { email: ME.toUpperCase() });
    assert.deepEqual(ids(result), ["new", "mid", "old"]);
    assert.equal(result.truncated, false);
  });

  it("filters by read status", async () => {
    const db = await seed([
      { id: "r", read: true },
      { id: "u", read: false, ago: 1 },
    ]);
    assert.deepEqual(
      ids(await searchNotifications(db, { email: ME, status: "unread" })),
      ["u"],
    );
    assert.deepEqual(
      ids(await searchNotifications(db, { email: ME, status: "read" })),
      ["r"],
    );
  });

  it("filters by category and severity, and tags each row's category", async () => {
    const db = await seed([
      { id: "g", type: "grading.jobFailed", severity: "WARN" },
      { id: "s", type: "deepseek.lowBalance", severity: "CRITICAL", ago: 1 },
    ]);
    const system = await searchNotifications(db, {
      email: ME,
      category: "system",
    });
    assert.deepEqual(ids(system), ["s"]);
    assert.equal(system.results[0].category, "system");
    assert.deepEqual(
      ids(await searchNotifications(db, { email: ME, severity: "WARN" })),
      ["g"],
    );
  });

  it("drops rows older than `since`", async () => {
    const db = await seed([
      { id: "today", ago: 0 },
      { id: "lastWeek", ago: 6 },
      { id: "lastMonth", ago: 20 },
    ]);
    const since = new Date(NOW - 7 * DAY).toISOString();
    assert.deepEqual(ids(await searchNotifications(db, { email: ME, since })), [
      "today",
      "lastWeek",
    ]);
  });

  it("flags a scan that hit its cap", async () => {
    const rows = Array.from(
      { length: NOTIFICATION_SEARCH_SCAN_LIMIT + 3 },
      (_, i) => ({ id: `n${i}`, ago: i / 1000 }),
    );
    const result = await searchNotifications(await seed(rows), { email: ME });
    assert.equal(result.truncated, true);
    assert.equal(result.results.length, NOTIFICATION_SEARCH_SCAN_LIMIT);
  });

  it("answers empty for a missing viewer", async () => {
    const db = await seed([{ id: "x" }]);
    assert.deepEqual(await searchNotifications(db, {}), {
      results: [],
      truncated: false,
    });
  });
});
