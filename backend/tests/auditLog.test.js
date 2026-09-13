const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  entityIdFromPath,
  filterOptions,
  matchAction,
  shouldAudit,
} = require("../lib/auditActions.js");
const {
  MAX_DETAIL_LENGTH,
  redact,
  safeJson,
  snapshotBody,
  summarizeBody,
  truncate,
} = require("../lib/auditLog.js");

// --- redact ---------------------------------------------------------------

test("redact: hides sensitive values at the top level", () => {
  const out = redact({ username: "ha", password: "s3cret" });
  assert.equal(out.username, "ha");
  assert.equal(out.password, "[REDACTED]");
});

test("redact: hides sensitive values nested in objects and arrays", () => {
  const out = redact({
    user: { name: "ha", credentials: { newPassword: "abc", token: "xyz" } },
    batch: [{ code: "one-time" }, { safe: "keep" }],
  });
  assert.equal(out.user.name, "ha");
  assert.equal(out.user.credentials.newPassword, "[REDACTED]");
  assert.equal(out.user.credentials.token, "[REDACTED]");
  assert.equal(out.batch[0].code, "[REDACTED]");
  assert.equal(out.batch[1].safe, "keep");
});

test("redact: key matching ignores case", () => {
  const out = redact({ PASSWORD: "a", Refresh_Token: "b", ApiKey: "c" });
  assert.equal(out.PASSWORD, "[REDACTED]");
  assert.equal(out.Refresh_Token, "[REDACTED]");
  assert.equal(out.ApiKey, "[REDACTED]");
});

test("redact: leaves primitives and non-sensitive data alone", () => {
  assert.equal(redact("plain"), "plain");
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.deepEqual(redact({ classId: "c1", count: 3 }), {
    classId: "c1",
    count: 3,
  });
});

// --- safeJson -------------------------------------------------------------

test("safeJson: a circular object does not throw", () => {
  const node = { name: "loop" };
  node.self = node;
  const json = safeJson(node);
  assert.match(json, /Circular/);
});

test("safeJson: long arrays are summarized, short ones kept whole", () => {
  const many = safeJson(Array.from({ length: 30 }, (_, i) => i));
  assert.match(many, /\+10 more/);
  assert.equal(safeJson([1, 2, 3]), "[1,2,3]");
});

// --- truncate / summarizeBody --------------------------------------------

test("truncate: cuts to the limit and marks the cut", () => {
  const out = truncate("x".repeat(600), 500);
  assert.equal(out.length, 501); // 500 chars + the ellipsis marker
  assert.ok(out.endsWith("…"));
  assert.equal(truncate("short", 500), "short");
});

test("summarizeBody: takes ONLY a body — no route/path argument", () => {
  // Guards the architecture: business rules live in lib/auditActions.js, so
  // this function must never grow a per-route parameter.
  assert.equal(summarizeBody.length, 1);
});

test("summarizeBody: redacts credentials from a real login body", () => {
  const detail = summarizeBody({ username: "ha", password: "s3cret" });
  assert.ok(detail.includes("ha"));
  assert.ok(!detail.includes("s3cret"));
  assert.ok(detail.includes("[REDACTED]"));
});

test("summarizeBody: redacts a signup body without knowing the route", () => {
  const detail = summarizeBody({
    name: "Teacher A",
    gmail: "a@example.com",
    password: "hunter2",
    token: "abc.def",
  });
  assert.ok(!detail.includes("hunter2"));
  assert.ok(!detail.includes("abc.def"));
  assert.ok(detail.includes("a@example.com"));
});

test("summarizeBody: caps the stored detail length", () => {
  const detail = summarizeBody({ note: "y".repeat(2000) });
  assert.ok(detail.length <= MAX_DETAIL_LENGTH + 1);
});

test("summarizeBody: empty-ish bodies produce an empty detail", () => {
  assert.equal(summarizeBody(undefined), "");
  assert.equal(summarizeBody(null), "");
  assert.equal(summarizeBody({}), "");
});

// --- snapshotBody ---------------------------------------------------------

test("snapshotBody: later mutation of req.body does not change the snapshot", () => {
  const body = { question: "original", nested: { answer: "keep" } };
  const snapshot = snapshotBody(body);
  body.question = "mutated by the route handler";
  body.nested.answer = "also mutated";
  assert.equal(snapshot.question, "original");
  assert.equal(snapshot.nested.answer, "keep");
});

// --- matchAction ----------------------------------------------------------

test("matchAction: teacher routes", () => {
  assert.equal(matchAction("POST", "/teachers").action, "teacher.create");
  assert.equal(matchAction("PATCH", "/teachers/abc").action, "teacher.update");
  const del = matchAction("DELETE", "/teachers/abc");
  assert.equal(del.action, "teacher.delete");
  assert.equal(del.severity, "CRITICAL");
  assert.equal(del.resourceType, "teacher");
  assert.equal(matchAction("POST", "/teacher-signup").action, "teacher.signup");
});

test("matchAction: more specific class route wins over /classes/:id", () => {
  assert.equal(
    matchAction("PATCH", "/classes/current-lesson").action,
    "class.currentLesson.update",
  );
  assert.equal(matchAction("PATCH", "/classes/abc").action, "class.update");
  assert.equal(matchAction("POST", "/classes").action, "class.create");
});

test("matchAction: more specific point routes win over /teacher-points/:id", () => {
  assert.equal(
    matchAction("POST", "/teacher-points/abc/topup").action,
    "points.topup",
  );
  assert.equal(
    matchAction("PATCH", "/teacher-points/abc").action,
    "points.update",
  );
  assert.equal(
    matchAction("DELETE", "/teacher-points/abc").action,
    "points.delete",
  );
});

test("matchAction: the run summary replaces the per-charge point entry", () => {
  assert.equal(
    matchAction("POST", "/grading-summary").action,
    "grading.pointsSummary",
  );
});

test("matchAction: bulk-delete wins over the plain grading-cache POST", () => {
  assert.equal(
    matchAction("POST", "/grading-cache/bulk-delete").action,
    "cache.bulkDelete",
  );
  assert.equal(matchAction("POST", "/grading-cache").action, "cache.create");
  assert.equal(
    matchAction("PATCH", "/grading-cache/abc").action,
    "cache.update",
  );
  assert.equal(
    matchAction("DELETE", "/grading-cache/abc").action,
    "cache.delete",
  );
});

test("matchAction: students and grading", () => {
  assert.equal(matchAction("POST", "/students").action, "student.create");
  assert.equal(matchAction("POST", "/grade-cached").action, "grading.run");
});

test("matchAction: both login routes share one action, with a failure variant", () => {
  const byPassword = matchAction("POST", "/auth/username-password");
  const byGoogle = matchAction("POST", "/auth/google");
  assert.equal(byPassword.action, "auth.login");
  assert.equal(byGoogle.action, "auth.login");
  assert.equal(byPassword.failedAction, "auth.loginFailed");
  assert.equal(byPassword.failedSeverity, "WARN");
  assert.equal(
    matchAction("POST", "/auth/reset-password").severity,
    "CRITICAL",
  );
});

test("matchAction: an unlisted route is still audited, under a generic name", () => {
  const fallback = matchAction("POST", "/exam");
  assert.equal(fallback.action, "POST /exam");
  assert.equal(fallback.resourceType, "other");
  assert.equal(fallback.severity, "INFO");
});

test("matchAction: the query string is ignored and the method is normalized", () => {
  assert.equal(
    matchAction("post", "/students?classId=1").action,
    "student.create",
  );
});

// --- shouldAudit ----------------------------------------------------------

test("shouldAudit: writes yes, reads and token churn no", () => {
  assert.equal(shouldAudit("POST", "/students"), true);
  assert.equal(shouldAudit("DELETE", "/teachers/abc"), true);
  assert.equal(shouldAudit("GET", "/classes"), false);
  assert.equal(shouldAudit("OPTIONS", "/students"), false);
  // Hit every 60s per open tab by proactiveTokenRefresh — would bury real actions.
  assert.equal(shouldAudit("POST", "/auth/refresh"), false);
  assert.equal(shouldAudit("GET", "/auth/google-token"), false);
  // Writes its own entry (auth.logout); auditing the POST too would double-log.
  assert.equal(shouldAudit("POST", "/audit-logs/client-event"), false);
  // Charges fire many times per grading run; /grading-summary covers the run.
  assert.equal(shouldAudit("POST", "/teacher-points/consume"), false);
});

// --- entityIdFromPath -----------------------------------------------------

test("entityIdFromPath: reads the record id out of the URL", () => {
  assert.equal(entityIdFromPath("/teachers/abc123"), "abc123");
  assert.equal(entityIdFromPath("/teacher-points/abc123/topup"), "abc123");
  assert.equal(entityIdFromPath("/grading-cache/xyz"), "xyz");
});

test("entityIdFromPath: collection-level and verb paths have no id", () => {
  assert.equal(entityIdFromPath("/students"), null);
  assert.equal(entityIdFromPath("/classes/current-lesson"), null);
  assert.equal(entityIdFromPath("/grading-cache/bulk-delete"), null);
  assert.equal(entityIdFromPath("/auth/username-password"), null);
});

// --- filterOptions --------------------------------------------------------

test("filterOptions: derived from the action table, no hard-coded copy", () => {
  const options = filterOptions();
  assert.ok(options.action.includes("teacher.delete"));
  assert.ok(options.action.includes("auth.loginFailed")); // failure variant
  assert.ok(options.action.includes("auth.logout")); // client-only event
  assert.ok(options.resourceType.includes("teacher"));
  assert.deepEqual(options.severity, ["INFO", "WARN", "CRITICAL"]);
  assert.deepEqual(options.success, ["true", "false"]);
});

// --- push/FCM token redaction ---------------------------------------------

test("redact: hides FCM / web-push registration tokens under every spelling", () => {
  const out = redact({
    token: "fcm-A",
    fcmToken: "fcm-B",
    fcm_token: "fcm-C",
    registrationToken: "fcm-D",
    deviceToken: "fcm-E",
    messagingToken: "fcm-F",
    vapidKey: "vapid-G",
    tokenHash: "safe-hash",
  });
  for (const key of [
    "token",
    "fcmToken",
    "fcm_token",
    "registrationToken",
    "deviceToken",
    "messagingToken",
    "vapidKey",
  ]) {
    assert.equal(out[key], "[REDACTED]", `${key} must be redacted`);
  }
  // tokenHash is a SHA-256 digest, not a capability — it stays readable so the
  // admin screen can still identify which device a row is about.
  assert.equal(out.tokenHash, "safe-hash");
});

test("redact: a push token nested in a device registration body is caught", () => {
  const out = redact({
    device: { platform: "web", fcmToken: "fcm-secret" },
    devices: [{ registration_token: "fcm-secret-2" }],
  });
  assert.equal(out.device.fcmToken, "[REDACTED]");
  assert.equal(out.devices[0].registration_token, "[REDACTED]");
});

// --- notification / balance routes ----------------------------------------

test("entityIdFromPath: notification and balance routes", () => {
  assert.equal(entityIdFromPath("/notifications/abc123/read"), "abc123");
  assert.equal(entityIdFromPath("/notifications/read-all"), null);
  assert.equal(entityIdFromPath("/notifications/devices"), null);
  // Only the SHA-256 hash appears in the URL, never the token itself.
  assert.equal(entityIdFromPath("/notifications/devices/deadbeef"), "deadbeef");
});

test("filterOptions: includes background SYSTEM actions the middleware never sees", () => {
  const options = filterOptions();
  assert.ok(options.action.includes("ai.lowBalanceAlert"));
  assert.ok(options.action.includes("ai.balanceUnavailable"));
  assert.ok(options.action.includes("ai.balanceRecovered"));
  assert.ok(options.action.includes("ai.balanceCheckFailed"));
  assert.ok(options.action.includes("ai.balanceCheck.manual")); // route-produced
  assert.ok(options.action.includes("notification.device.register"));
  assert.ok(options.resourceType.includes("ai"));
  assert.ok(options.resourceType.includes("notification"));
  assert.ok(options.method.includes("SYSTEM"));
});
