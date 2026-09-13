/**
 * Audit configuration — THE only place that knows about routes.
 *
 * lib/auditLog.js stays purely technical (redact → serialize → truncate → write).
 * Everything business-specific lives here as data, so adding an API means adding
 * ONE ROW below — no function anywhere needs to change.
 *
 * Consumers (all read from these same constants, nothing is duplicated):
 *   - the audit middleware in server.js
 *   - GET /audit-logs/filter-options (dropdown values for the admin screen)
 *   - POST /audit-logs/client-event  (CLIENT_ACTIONS whitelist)
 */

/** Severity levels, low → high. `success: false` is bumped to at least WARN. */
const SEVERITIES = ["INFO", "WARN", "CRITICAL"];

/**
 * Route → action table. Scanned top-down, FIRST MATCH WINS, so put the more
 * specific pattern above the generic one (e.g. /classes/current-lesson before
 * /classes/:id, /grading-cache/bulk-delete before /grading-cache).
 *
 * Optional `failedAction` / `failedSeverity` apply when the request failed —
 * that is how a bad password becomes `auth.loginFailed` instead of `auth.login`.
 */
const AUDIT_ACTIONS = [
  // --- teachers ---
  {
    method: "POST",
    pattern: /^\/teachers$/,
    action: "teacher.create",
    resourceType: "teacher",
    severity: "WARN",
  },
  {
    method: "PATCH",
    pattern: /^\/teachers\/[^/]+$/,
    action: "teacher.update",
    resourceType: "teacher",
    severity: "WARN",
  },
  {
    method: "DELETE",
    pattern: /^\/teachers\/[^/]+$/,
    action: "teacher.delete",
    resourceType: "teacher",
    severity: "CRITICAL",
  },
  {
    method: "POST",
    pattern: /^\/teacher-signup$/,
    action: "teacher.signup",
    resourceType: "teacher",
    severity: "INFO",
  },

  // --- classes ---
  {
    method: "POST",
    pattern: /^\/classes$/,
    action: "class.create",
    resourceType: "class",
    severity: "INFO",
  },
  // Must precede /classes/:id — "current-lesson" would match that pattern too.
  {
    method: "PATCH",
    pattern: /^\/classes\/current-lesson$/,
    action: "class.currentLesson.update",
    resourceType: "class",
    severity: "INFO",
  },
  {
    method: "PATCH",
    pattern: /^\/classes\/[^/]+$/,
    action: "class.update",
    resourceType: "class",
    severity: "INFO",
  },

  // --- students ---
  {
    method: "POST",
    pattern: /^\/students\/bulk-delete$/,
    action: "student.bulkDelete",
    resourceType: "student",
    severity: "WARN",
  },
  {
    method: "POST",
    pattern: /^\/students$/,
    action: "student.create",
    resourceType: "student",
    severity: "INFO",
  },
  {
    method: "DELETE",
    pattern: /^\/students\/[^/]+$/,
    action: "student.delete",
    resourceType: "student",
    severity: "WARN",
  },

  // --- grading ---
  {
    method: "POST",
    pattern: /^\/grade-cached$/,
    action: "grading.run",
    resourceType: "grading",
    severity: "INFO",
  },
  {
    method: "POST",
    pattern: /^\/grade$/,
    action: "grading.runExtension",
    resourceType: "grading",
    severity: "INFO",
  },
  // Closes out a run: class, lesson, and the total points it cost. Stands in
  // for the per-charge entries that SKIP_PATHS drops.
  {
    method: "POST",
    pattern: /^\/grading-summary$/,
    action: "grading.pointsSummary",
    resourceType: "points",
    severity: "INFO",
  },

  // Feedback is written to (and cleared from) Google Docs straight from the
  // browser, so no route ever sees it — the website reports the run itself.
  {
    method: "POST",
    pattern: /^\/feedback-clear-summary$/,
    action: "doc.feedback.clear",
    resourceType: "grading",
    severity: "WARN",
  },

  // --- points (money) ---
  // NOTE: /teacher-points/consume is NOT here — see SKIP_PATHS. One grading run
  // charges repeatedly, so auditing each charge buries every real action.
  // Must precede /teacher-points/:id — the topup path has an extra segment.
  {
    method: "POST",
    pattern: /^\/teacher-points\/[^/]+\/topup$/,
    action: "points.topup",
    resourceType: "points",
    severity: "CRITICAL",
  },
  {
    method: "POST",
    pattern: /^\/teacher-points$/,
    action: "points.create",
    resourceType: "points",
    severity: "CRITICAL",
  },
  {
    method: "PATCH",
    pattern: /^\/teacher-points\/[^/]+$/,
    action: "points.update",
    resourceType: "points",
    severity: "CRITICAL",
  },
  {
    method: "DELETE",
    pattern: /^\/teacher-points\/[^/]+$/,
    action: "points.delete",
    resourceType: "points",
    severity: "CRITICAL",
  },

  // --- grading cache ---
  // Must precede /grading-cache — same prefix, extra segment.
  {
    method: "POST",
    pattern: /^\/grading-cache\/bulk-delete$/,
    action: "cache.bulkDelete",
    resourceType: "cache",
    severity: "CRITICAL",
  },
  {
    method: "POST",
    pattern: /^\/grading-cache$/,
    action: "cache.create",
    resourceType: "cache",
    severity: "INFO",
  },
  {
    method: "PATCH",
    pattern: /^\/grading-cache\/[^/]+$/,
    action: "cache.update",
    resourceType: "cache",
    severity: "INFO",
  },
  {
    method: "DELETE",
    pattern: /^\/grading-cache\/[^/]+$/,
    action: "cache.delete",
    resourceType: "cache",
    severity: "WARN",
  },

  // --- auth ---
  {
    method: "POST",
    pattern: /^\/auth\/(username-password|google)$/,
    action: "auth.login",
    resourceType: "auth",
    severity: "INFO",
    failedAction: "auth.loginFailed",
    failedSeverity: "WARN",
  },
  {
    method: "POST",
    pattern: /^\/auth\/forgot-password$/,
    action: "auth.forgotPassword",
    resourceType: "auth",
    severity: "WARN",
  },
  {
    method: "POST",
    pattern: /^\/auth\/reset-password$/,
    action: "auth.resetPassword",
    resourceType: "auth",
    severity: "CRITICAL",
  },

  // --- notifications (admin) ---
  // The body field is named `token`, which REDACT_KEYS already masks, so the
  // FCM token never reaches a row. See the auditDetail set by the route.
  {
    method: "POST",
    pattern: /^\/notifications\/devices$/,
    action: "notification.device.register",
    resourceType: "notification",
    severity: "INFO",
  },
  {
    method: "DELETE",
    pattern: /^\/notifications\/devices\/[^/]+$/,
    action: "notification.device.unregister",
    resourceType: "notification",
    severity: "INFO",
  },
  // Must precede /notifications/:id/read — both are POSTs under /notifications.
  {
    method: "POST",
    pattern: /^\/notifications\/read-all$/,
    action: "notification.readAll",
    resourceType: "notification",
    severity: "INFO",
  },
  {
    method: "POST",
    pattern: /^\/notifications\/[^/]+\/read$/,
    action: "notification.read",
    resourceType: "notification",
    severity: "INFO",
  },

  // --- AI provider ---
  {
    method: "POST",
    pattern: /^\/admin\/deepseek-balance\/check$/,
    action: "ai.balanceCheck.manual",
    resourceType: "ai",
    severity: "WARN",
  },
];

/**
 * Client-only events (no HTTP request of their own reaches a route, so the
 * middleware cannot see them). Whitelist for POST /audit-logs/client-event —
 * the actor always comes from the token, never from the request body.
 */
const CLIENT_ACTIONS = {
  "auth.logout": { resourceType: "auth", severity: "INFO" },
};

/**
 * Background events produced by server-side code with no HTTP request of their
 * own, so the middleware can never see them — but they must still reach the
 * audit trail and its filter dropdowns. Written via recordAudit with
 * method: "SYSTEM" and no actor. Same idea as CLIENT_ACTIONS: this file stays
 * the single place that knows every action name.
 */
const SYSTEM_ACTIONS = {
  "ai.lowBalanceAlert": { resourceType: "ai", severity: "CRITICAL" },
  "ai.balanceUnavailable": { resourceType: "ai", severity: "CRITICAL" },
  "ai.balanceRecovered": { resourceType: "ai", severity: "INFO" },
  "ai.balanceCheckFailed": { resourceType: "ai", severity: "WARN" },
  "grading.notifiedTeacher": {
    resourceType: "notification",
    severity: "INFO",
  },
};

/**
 * GETs are not audited (they are reads), EXCEPT the ones listed here — add
 * export / download / backup style endpoints as they appear.
 */
const AUDITED_GETS = [];

/**
 * Never audited by the middleware.
 *
 * /auth/refresh and /auth/google-token are hit by the website's
 * proactiveTokenRefresh every 60s per open tab; auditing them would bury the
 * real actions. /audit-logs/client-event writes its own (meaningful) entry, so
 * auditing the POST as well would double-log every logout.
 *
 * /teacher-points/consume fires once per pair of graded docs, so a single class
 * would add dozens of rows. The money trail is not lost: every charge writes a
 * TeacherPointLedger receipt, and /grading-summary logs one row per run.
 */
const SKIP_PATHS = [
  "/auth/refresh",
  "/auth/google-token",
  "/exchange-token",
  "/audit-logs/client-event",
  "/teacher-points/consume",
];

/** Actions the middleware never produces, so filter-options must add them. */
const EXTRA_ACTIONS = [
  ...Object.keys(CLIENT_ACTIONS),
  ...Object.keys(SYSTEM_ACTIONS),
];

/**
 * Resolves a request to its audit descriptor.
 *
 * An unknown route still gets audited (fallback below) — better a generic entry
 * than a silent gap. Add a row to AUDIT_ACTIONS to give it a proper name.
 *
 * @param {string} method HTTP method
 * @param {string} path   pathname, WITHOUT the query string
 * @returns {{action: string, resourceType: string, severity: string, failedAction?: string, failedSeverity?: string}}
 */
function matchAction(method, path) {
  const upperMethod = String(method || "").toUpperCase();
  const cleanPath = String(path || "").split("?")[0];
  const hit = AUDIT_ACTIONS.find(
    (entry) => entry.method === upperMethod && entry.pattern.test(cleanPath),
  );
  if (hit) {
    return {
      action: hit.action,
      resourceType: hit.resourceType,
      severity: hit.severity,
      failedAction: hit.failedAction,
      failedSeverity: hit.failedSeverity,
    };
  }
  return {
    action: `${upperMethod} ${cleanPath}`,
    resourceType: "other",
    severity: "INFO",
  };
}

/** True when this request should be audited at all (see AUDITED_GETS/SKIP_PATHS). */
function shouldAudit(method, path) {
  const upperMethod = String(method || "").toUpperCase();
  const cleanPath = String(path || "").split("?")[0];
  if (SKIP_PATHS.includes(cleanPath)) return false;
  if (upperMethod === "HEAD" || upperMethod === "OPTIONS") return false;
  if (upperMethod === "GET") return AUDITED_GETS.includes(cleanPath);
  return true;
}

/**
 * Trailing path segments that name an operation rather than a record, so the id
 * (when there is one) sits just before them: /teacher-points/:id/topup.
 */
const TRAILING_ACTION_SEGMENTS = [
  "topup",
  "bulk-delete",
  "consume",
  "current-lesson",
  "check-name",
  "client-event",
  "filter-options",
  "billing",
  "manage",
  "refresh",
  "all",
  "me",
  "read",
  "read-all",
  "devices",
  "check",
];

/**
 * Best-effort record id from the URL.
 *
 * Derived from the path rather than req.params because the audit entry is built
 * in res.on("finish"), by which point Express has already restored req.params
 * from the route layer.
 */
function entityIdFromPath(path) {
  const segments = String(path || "")
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  if (segments.length < 2) return null;
  // /auth/* paths are verbs, not records.
  if (segments[0] === "auth") return null;

  const last = segments[segments.length - 1];
  if (!TRAILING_ACTION_SEGMENTS.includes(last)) return last;

  const previous = segments[segments.length - 2];
  if (segments.length < 3 || TRAILING_ACTION_SEGMENTS.includes(previous)) {
    return null;
  }
  return previous;
}

/** Distinct values for the enum-typed filters, derived from the table above. */
function filterOptions() {
  const actions = new Set(EXTRA_ACTIONS);
  const resourceTypes = new Set(["other"]);
  AUDIT_ACTIONS.forEach((entry) => {
    actions.add(entry.action);
    if (entry.failedAction) actions.add(entry.failedAction);
    resourceTypes.add(entry.resourceType);
  });
  Object.values(CLIENT_ACTIONS).forEach((entry) =>
    resourceTypes.add(entry.resourceType),
  );
  Object.values(SYSTEM_ACTIONS).forEach((entry) =>
    resourceTypes.add(entry.resourceType),
  );
  return {
    action: [...actions].sort(),
    resourceType: [...resourceTypes].sort(),
    severity: [...SEVERITIES],
    // SYSTEM covers background events (SYSTEM_ACTIONS) that no route produces.
    method: ["POST", "PATCH", "PUT", "DELETE", "GET", "SYSTEM"],
    success: ["true", "false"],
  };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDITED_GETS,
  CLIENT_ACTIONS,
  SEVERITIES,
  SYSTEM_ACTIONS,
  SKIP_PATHS,
  entityIdFromPath,
  filterOptions,
  matchAction,
  shouldAudit,
};
