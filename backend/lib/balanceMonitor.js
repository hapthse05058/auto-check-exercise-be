/**
 * DeepSeek balance monitor — the orchestrator.
 *
 * Decision logic lives in lib/deepseekBalance.js (pure, unit-tested); storage
 * and delivery live in lib/notifications.js and lib/pushDevices.js. This file
 * only sequences them and owns the concurrency story.
 *
 * ---------------------------------------------------------------------------
 * WHY THE THROTTLE LOOKS LIKE THIS
 *
 * The check is fired opportunistically from the grading routes, so on a busy
 * afternoon it would otherwise run hundreds of times an hour, across several
 * Cloud Run instances at once. Two tiers keep that honest:
 *
 *   Tier 1 — a module-scope `lastLocalCheckAt`. Cheap: the overwhelming
 *   majority of grading runs return here without touching Firestore. It is only
 *   an optimisation, never the source of truth — Cloud Run scales to zero, so a
 *   cold start resets it.
 *
 *   Tier 2 — a Firestore transaction that CLAIMS the slot *before* the HTTP
 *   call, by writing `lastCheckedAt` up front. Two instances finishing a
 *   grading run in the same second therefore cannot both call DeepSeek: the
 *   loser sees a fresh timestamp and backs off. `Timestamp.now()` rather than
 *   `serverTimestamp()` because the value is read back and compared to the
 *   wall clock.
 *
 * A failed HTTP call KEEPS the claimed timestamp. A revoked API key must not
 * turn into an outbound request on every single grading run.
 *
 * The alert decision is a second transaction, so the state read that feeds
 * decideAlert and the state write that records its outcome cannot interleave
 * with another instance. That transaction returns the incremented alertCount,
 * which becomes the notification's deterministic doc id — so even a crash and
 * retry between the two writes cannot produce a duplicate in the bell.
 * ---------------------------------------------------------------------------
 */
const auditActions = require("./auditActions.js");
const auditLog = require("./auditLog.js");
const deepseekBalance = require("./deepseekBalance.js");
const notifications = require("./notifications.js");
const pushDevices = require("./pushDevices.js");

const STATE_COLLECTION = "systemState";
const STATE_DOC = "deepseekBalance";

/** Tier-1 throttle (see the header). Per-instance, deliberately not persisted. */
let lastLocalCheckAt = 0;

/** Firestore state doc -> the plain-JS shape decideAlert expects. */
function toPlainState(data) {
  const base = deepseekBalance.initialState();
  if (!data) return base;
  return {
    status: data.status || base.status,
    lastAlertAt: data.lastAlertAt?.toMillis?.() ?? null,
    lastFingerprint: data.lastFingerprint ?? null,
    lastThreshold: data.lastThreshold === undefined ? null : data.lastThreshold,
    alertCount: data.alertCount || 0,
    consecutiveErrors: data.consecutiveErrors || 0,
  };
}

/**
 * Runs one balance check and alerts if the state machine says so.
 *
 * Never throws: callers fire this without awaiting, so an unhandled rejection
 * would take the process down. Every failure path returns a `{ skipped }` or
 * `{ error }` object instead.
 *
 * @param {object}   opts
 * @param {object}   opts.db            Firestore handle (lib/firestore.js)
 * @param {object}   opts.admin         firebase-admin namespace
 * @param {string[]} opts.adminEmails   ADMIN_EMAILS — the alert recipients
 * @param {boolean}  [opts.force]       bypass both throttle and re-alert gate
 * @param {string}   [opts.requestId]   for tracing back to the grading run
 * @param {object}   [opts.env]         override for tests
 */
async function maybeCheckAndAlert({
  db,
  admin,
  adminEmails = [],
  force = false,
  requestId = null,
  env = process.env,
}) {
  const policy = deepseekBalance.readPolicy(env);
  if (!policy.enabled && !force) return { skipped: "disabled" };

  const now = Date.now();
  if (!force && now - lastLocalCheckAt < policy.checkIntervalMs) {
    return { skipped: "throttled_local" };
  }

  const stateRef = db.collection(STATE_COLLECTION).doc(STATE_DOC);

  // --- Tier 2: claim the slot BEFORE spending an outbound request ---------
  let previousState;
  try {
    previousState = await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      const data = snap.exists ? snap.data() : null;
      const lastCheckedAt = data?.lastCheckedAt?.toMillis?.() ?? 0;
      if (!force && Date.now() - lastCheckedAt < policy.checkIntervalMs) {
        return null;
      }
      tx.set(
        stateRef,
        { lastCheckedAt: admin.firestore.Timestamp.now() },
        { merge: true },
      );
      return toPlainState(data);
    });
  } catch (err) {
    console.error("[BALANCE] claim failed:", err.message);
    return { skipped: "claim_failed", error: err.message };
  }

  if (previousState === null) return { skipped: "throttled" };
  lastLocalCheckAt = Date.now();

  // --- Read the balance ---------------------------------------------------
  const thresholds = deepseekBalance.readThresholds(env);
  const url = deepseekBalance.balanceUrl(
    env.AI_BASE_URL,
    env.DEEPSEEK_BALANCE_URL,
  );
  const fetched = await deepseekBalance.fetchBalance({
    // A dedicated key is only needed when AI_API_KEY lacks permission on
    // /user/balance (some sub-keys and proxies do); otherwise reuse it.
    apiKey: env.DEEPSEEK_BALANCE_API_KEY || env.AI_API_KEY,
    url,
    timeoutMs: policy.timeoutMs,
  });

  const evaluation = fetched.ok
    ? deepseekBalance.evaluateBalance(fetched.payload, thresholds)
    : deepseekBalance.failedEvaluation(fetched.error);

  // --- Decide + persist atomically ---------------------------------------
  let decision;
  try {
    decision = await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      const current = toPlainState(snap.exists ? snap.data() : null);
      const outcome = deepseekBalance.decideAlert(
        force ? { ...current, lastAlertAt: null } : current,
        evaluation,
        Date.now(),
        policy,
      );
      const next = outcome.nextState;
      tx.set(
        stateRef,
        {
          status: next.status,
          lastAlertAt:
            next.lastAlertAt === null
              ? null
              : admin.firestore.Timestamp.fromMillis(next.lastAlertAt),
          lastFingerprint: next.lastFingerprint,
          lastThreshold: next.lastThreshold ?? null,
          alertCount: next.alertCount,
          consecutiveErrors: next.consecutiveErrors,
          lastBalances: evaluation.balances || [],
          lastCheckStatus: evaluation.ok ? evaluation.reason : "error",
          lastError: evaluation.ok ? null : evaluation.error || null,
          updatedAt: admin.firestore.Timestamp.now(),
        },
        { merge: true },
      );
      return outcome;
    });
  } catch (err) {
    console.error("[BALANCE] state write failed:", err.message);
    return { skipped: "state_write_failed", error: err.message, evaluation };
  }

  if (!decision.shouldAlert) {
    console.warn(
      `[BALANCE] ${evaluation.reason} — no alert (${decision.reason})`,
    );
    return { evaluation, decision, alerted: false };
  }

  // --- Deliver ------------------------------------------------------------
  const alert = deepseekBalance.describeAlert(decision.kind, evaluation);
  const id = notifications.notificationId(
    alert.type,
    evaluation.fingerprint,
    decision.nextState.alertCount,
  );

  let notificationId = null;
  try {
    notificationId = await notifications.createNotification(db, admin, {
      id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      data: alert.data,
      recipients: adminEmails,
      sourceRequestId: requestId,
    });
  } catch (err) {
    console.error("[BALANCE] notification write failed:", err.message);
  }

  // Push is best effort and must never break the alert — the in-app
  // notification above is the reliable channel and is already stored.
  let push = null;
  try {
    const devices = await pushDevices.listActiveTokens(db, adminEmails);
    push = await pushDevices.sendPush(admin, db, {
      tokens: devices,
      title: alert.title,
      body: alert.body,
      data: { type: alert.type, notificationId: notificationId || "" },
      link: env.PUBLIC_WEB_URL || undefined,
    });
    if (notificationId) {
      await notifications.recordPushResult(db, admin, notificationId, push);
    }
  } catch (err) {
    console.error("[BALANCE] push failed:", err.message);
  }

  // The middleware never sees this event (no HTTP request of its own), so it
  // writes its own row — same precedent as POST /audit-logs/client-event.
  const action = deepseekBalance.auditActionFor(decision.kind);
  const descriptor = auditActions.SYSTEM_ACTIONS[action] || {
    resourceType: "ai",
    severity: alert.severity,
  };
  await auditLog.recordAudit(db, admin, {
    requestId,
    actorEmail: null,
    actorResolvedFrom: "system",
    action,
    resourceType: descriptor.resourceType,
    severity: descriptor.severity,
    method: "SYSTEM",
    path: "/system/deepseek-balance",
    entityId: notificationId,
    success: true,
    detail: alert.body,
  });

  console.warn(`[BALANCE] ALERT ${alert.type} — ${alert.body}`);
  return { evaluation, decision, alerted: true, notificationId, push };
}

/** Test hook: clears the per-instance tier-1 throttle. */
function resetLocalThrottle() {
  lastLocalCheckAt = 0;
}

module.exports = {
  STATE_COLLECTION,
  STATE_DOC,
  maybeCheckAndAlert,
  resetLocalThrottle,
  toPlainState,
};
