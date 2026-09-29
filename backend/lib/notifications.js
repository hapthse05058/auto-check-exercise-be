/**
 * In-app notification store — the reliable half of the alert path.
 *
 * Purely technical, like lib/auditLog.js: it knows nothing about routes or
 * about what a notification means. Callers hand it a rendered alert; it stores,
 * lists and marks read.
 *
 * AUTHORISATION LIVES IN THE DATA, NOT IN THE ROUTE. Every read here is scoped
 * to the caller's own email via the `recipients` array, which is why the HTTP
 * routes only need authentication, not a role check: a teacher cannot see an
 * admin's DeepSeek balance alert because their address is not in its
 * `recipients`. Do not "tidy this up" by adding a role gate — that would be
 * both redundant and wrong, since teachers legitimately receive their own.
 *
 * Design notes worth keeping in mind when extending this:
 *
 *  - **Deterministic doc ids.** `notificationId(type, fingerprint, sequence)`
 *    hashes the alert's identity, so a retried alert `set()`s the same document
 *    instead of adding a duplicate to the bell.
 *
 *  - **`readBy` is an ARRAY, not a map.** Firestore dotted update paths cannot
 *    contain `.`, and every key here would be an email address. `arrayUnion` is
 *    one atomic write, and a notification has few recipients.
 *
 *  - **Both structured `data` and pre-rendered `title`/`body`.** The bell renders
 *    from i18n keys + `data` so it follows the viewer's language; the FCM payload
 *    and the service worker have no access to the i18n dictionary and use the
 *    stored strings.
 *
 *  - **TTL.** `expireAt` is the target of a Firestore TTL policy, same as
 *    `auditLogs.expireAt`. See backend/README.md for the gcloud command.
 */
const crypto = require("crypto");

const COLLECTION = "notifications";

/** Days a notification is kept before the Firestore TTL policy removes it.
 *  Changing this only affects NEW notifications; ones already written keep
 *  the expireAt they were stamped with. */
const NOTIFICATION_RETENTION_DAYS =
  Number(process.env.NOTIFICATION_RETENTION_DAYS) || 30;

/** Rows fetched per list call (see listNotifications for what this bounds). */
const NOTIFICATION_PAGE_LIMIT = 50;

/** Rows returned to the client by default. */
const NOTIFICATION_LIST_LIMIT = 50;

/** Rows scanned by the notifications page (searchNotifications). With the TTL
 *  a viewer's whole history fits well inside this; `truncated` says when not. */
const NOTIFICATION_SEARCH_SCAN_LIMIT = 500;

/** Filter values the notifications page may send. */
const SEARCH_STATUSES = ["all", "unread", "read"];
const SEARCH_CATEGORIES = ["all", "grading", "system"];
const SEARCH_SEVERITIES = ["all", "INFO", "WARN", "CRITICAL"];

/** "grading.jobDone" → "grading"; everything else (deepseek.*) → "system". */
function categoryOf(type) {
  return String(type || "").startsWith("grading.") ? "grading" : "system";
}

/**
 * Deterministic notification id.
 *
 * Keyed on what the alert IS (type + situation fingerprint + which alert in the
 * sequence it is), so the same alert written twice — a retry, a crash between
 * the state write and the notification write — collapses onto one document.
 */
function notificationId(type, fingerprint, sequence) {
  const raw = `${type}|${fingerprint}|${sequence}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

/**
 * Writes one notification. `id` is optional; without it a random id is used
 * (fine for one-off notifications that have no natural identity).
 */
async function createNotification(db, admin, entry) {
  const {
    id,
    type,
    severity = "INFO",
    title,
    body,
    data = {},
    recipients = [],
    sourceRequestId = null,
  } = entry;

  const now = admin.firestore.Timestamp.now();
  const expireAt = admin.firestore.Timestamp.fromMillis(
    now.toMillis() + NOTIFICATION_RETENTION_DAYS * 24 * 3600 * 1000,
  );

  const doc = {
    type,
    severity,
    title,
    body,
    data,
    // A snapshot of the recipient list at send time: someone added to the group
    // later will not see historical alerts, which is the behaviour we want.
    recipients: recipients.map((email) => String(email).toLowerCase()),
    // DELIBERATE: writing to an id that already exists RESETS readBy and moves
    // createdAt forward, so re-notifying the same subject (an admin grading the
    // same class+lesson twice in a day) bubbles the entry back to the top of the
    // bell and marks it unread again, rather than silently overwriting something
    // the recipient had already read and dismissed.
    readBy: [],
    createdAt: now,
    expireAt,
    sourceRequestId,
  };

  const ref = id
    ? db.collection(COLLECTION).doc(id)
    : db.collection(COLLECTION).doc();
  // merge:true only protects fields absent from `doc` above — which is why
  // pushResult/pushSentAt are NOT listed there: a rewrite keeps the push
  // outcome already recorded for this id instead of nulling it out.
  await ref.set(doc, { merge: true });
  return ref.id;
}

/** Records the outcome of the push attempt for a notification (best effort). */
async function recordPushResult(db, admin, id, pushResult) {
  try {
    await db.collection(COLLECTION).doc(id).update({
      pushResult,
      pushSentAt: admin.firestore.Timestamp.now(),
    });
  } catch (err) {
    console.error("[NOTIFY] recordPushResult failed:", err.message);
  }
}

/** Shapes a stored doc for the API, deriving `read` for this viewer. */
function toClient(snap, email) {
  const data = snap.data() || {};
  const readBy = Array.isArray(data.readBy) ? data.readBy : [];
  return {
    id: snap.id,
    type: data.type || null,
    category: categoryOf(data.type),
    severity: data.severity || "INFO",
    title: data.title || "",
    body: data.body || "",
    data: data.data || {},
    read: readBy.includes(email),
    createdAt: data.createdAt?.toDate?.()?.toISOString() ?? null,
  };
}

/**
 * Lists notifications addressed to `email`, newest first.
 *
 * Filtering happens IN THE QUERY, not in memory. An earlier version scanned the
 * newest 200 rows and filtered `recipients` afterwards, which was fine while
 * only a handful of admins ever received anything — but once every teacher gets
 * notified that becomes a CORRECTNESS bug, not just a cost one: one person's
 * notifications get pushed out of the scan window by everybody else's, and they
 * silently see nothing at all even though the documents are right there.
 *
 * Requires the composite index (recipients ARRAY_CONTAINS + createdAt DESC) —
 * declared in firestore.indexes.json at the repo root. Without it every call
 * fails with FAILED_PRECONDITION.
 *
 * `unreadCount` is counted in memory from THIS one page, so it means "unread
 * among the newest NOTIFICATION_PAGE_LIMIT", not an absolute total. Firestore
 * has no "array does not contain" operator, so an exact server-side count would
 * need a second denormalised counter; the bell caps its badge at 9+, which makes
 * the difference invisible in practice.
 */
async function listNotifications(
  db,
  { email, limit, unreadOnly = false } = {},
) {
  const viewer = String(email || "").toLowerCase();
  if (!viewer) return { results: [], unreadCount: 0, total: 0 };

  const snap = await db
    .collection(COLLECTION)
    .where("recipients", "array-contains", viewer)
    .orderBy("createdAt", "desc")
    .limit(NOTIFICATION_PAGE_LIMIT)
    .get();

  const all = snap.docs.map((doc) => toClient(doc, viewer));
  const unreadCount = all.filter((item) => !item.read).length;
  const visible = unreadOnly ? all.filter((item) => !item.read) : all;

  return {
    results: visible.slice(0, limit || NOTIFICATION_LIST_LIMIT),
    unreadCount,
    total: all.length,
  };
}

/**
 * The notifications page: everything addressed to `email`, filtered, newest
 * first.
 *
 * Scans the viewer's newest NOTIFICATION_SEARCH_SCAN_LIMIT rows with the same
 * query (and index) as listNotifications, then filters in memory. Firestore
 * cannot filter "readBy does not contain", and the other filters would each
 * need another composite index; with a 30-day TTL the scan already covers a
 * viewer's whole history. `truncated` is true when it may not have.
 *
 * `since` is an ISO timestamp (the page works out "today" in the viewer's own
 * timezone); null means no time filter.
 */
async function searchNotifications(
  db,
  {
    email,
    status = "all",
    category = "all",
    severity = "all",
    since = null,
  } = {},
) {
  const viewer = String(email || "").toLowerCase();
  if (!viewer) return { results: [], truncated: false };

  const snap = await db
    .collection(COLLECTION)
    .where("recipients", "array-contains", viewer)
    .orderBy("createdAt", "desc")
    .limit(NOTIFICATION_SEARCH_SCAN_LIMIT)
    .get();

  const sinceMs = since ? Date.parse(since) : null;
  const results = snap.docs
    .map((doc) => toClient(doc, viewer))
    .filter((item) =>
      status === "unread" ? !item.read : status === "read" ? item.read : true,
    )
    .filter((item) => category === "all" || item.category === category)
    .filter((item) => severity === "all" || item.severity === severity)
    .filter(
      (item) =>
        sinceMs === null ||
        (item.createdAt !== null && Date.parse(item.createdAt) >= sinceMs),
    )
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    results,
    truncated: snap.docs.length >= NOTIFICATION_SEARCH_SCAN_LIMIT,
  };
}

/**
 * Marks one notification read for one viewer.
 * Returns false when the notification does not exist or is not addressed to
 * them — the route turns that into a 404 rather than silently succeeding.
 */
async function markRead(db, admin, id, email) {
  const viewer = String(email || "").toLowerCase();
  const ref = db.collection(COLLECTION).doc(String(id));
  const snap = await ref.get();
  if (!snap.exists) return false;

  const recipients = snap.data()?.recipients;
  if (!Array.isArray(recipients) || !recipients.includes(viewer)) return false;

  await ref.update({
    readBy: admin.firestore.FieldValue.arrayUnion(viewer),
  });
  return true;
}

/**
 * Marks every notification currently addressed to `email` read.
 *
 * Scoped to the same page the bell actually shows (NOTIFICATION_PAGE_LIMIT):
 * "mark what I can see as read" is the honest contract, and it matches what the
 * user just looked at. Anything older is already off the end of the list.
 */
async function markAllRead(db, admin, email) {
  const viewer = String(email || "").toLowerCase();
  if (!viewer) return 0;

  const snap = await db
    .collection(COLLECTION)
    .where("recipients", "array-contains", viewer)
    .orderBy("createdAt", "desc")
    .limit(NOTIFICATION_PAGE_LIMIT)
    .get();

  const targets = snap.docs.filter((doc) => {
    const readBy = doc.data()?.readBy;
    return !(Array.isArray(readBy) ? readBy : []).includes(viewer);
  });

  const CHUNK = 400;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = db.batch();
    targets.slice(i, i + CHUNK).forEach((doc) => {
      batch.update(doc.ref, {
        readBy: admin.firestore.FieldValue.arrayUnion(viewer),
      });
    });
    await batch.commit();
  }
  return targets.length;
}

module.exports = {
  COLLECTION,
  NOTIFICATION_LIST_LIMIT,
  NOTIFICATION_RETENTION_DAYS,
  NOTIFICATION_PAGE_LIMIT,
  NOTIFICATION_SEARCH_SCAN_LIMIT,
  SEARCH_CATEGORIES,
  SEARCH_SEVERITIES,
  SEARCH_STATUSES,
  categoryOf,
  createNotification,
  listNotifications,
  searchNotifications,
  markAllRead,
  markRead,
  notificationId,
  recordPushResult,
  toClient,
};
