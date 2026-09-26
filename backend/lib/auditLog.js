/**
 * Audit log writer — purely technical, DELIBERATELY knows nothing about routes.
 *
 * Its whole job is: redact → serialize safely → truncate → write one Firestore
 * doc. There is no `if (path === "/teachers")` in this file and there must never
 * be one: all route/action/severity knowledge lives in lib/auditActions.js, so a
 * new API costs one config row instead of an edit here.
 *
 * Writes go to the `auditLogs` collection and carry `expireAt` (createdAt + 30d)
 * so a Firestore TTL policy on that field can delete them for free — see the
 * Audit log section of README.md and scripts/purgeAuditLogs.js.
 */

/** Retention window. Also documented in README.md (TTL policy) — keep in sync.
 *  Changing this only affects NEW rows; documents already written keep the
 *  expireAt they were stamped with. */
const AUDIT_RETENTION_DAYS = 60;

/** `detail` is a debugging aid, not a data mirror — cap it hard. */
const MAX_DETAIL_LENGTH = 500;

/** Arrays longer than this are summarized rather than serialized in full. */
const MAX_ARRAY_ITEMS = 20;

/** Actor name lookups are cached this long (ms) to keep writes off the hot path. */
const ACTOR_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Key names whose VALUES must never reach the log, compared lowercase so
 * `newPassword`, `NEWPASSWORD` and `newpassword` are all caught. Matching is by
 * key name and runs recursively, which is why route-specific redaction rules
 * are unnecessary: a credential is protected wherever it is nested.
 */
const REDACT_KEYS = [
  "password",
  "newpassword",
  "oldpassword",
  "currentpassword",
  "confirmpassword",
  "token",
  // FCM/web-push registration tokens: a capability to push to a device,
  // so they must never be readable from an audit row.
  "fcmtoken",
  "fcm_token",
  "registrationtoken",
  "registration_token",
  "devicetoken",
  "device_token",
  "messagingtoken",
  "messaging_token",
  "vapidkey",
  "vapid_key",
  "refreshtoken",
  "refresh_token",
  "accesstoken",
  "access_token",
  "idtoken",
  "id_token",
  "code",
  "resettoken",
  "reset_token",
  "secret",
  "clientsecret",
  "client_secret",
  "apikey",
  "api_key",
  "x-api-key",
  "authorization",
];

const REDACTED = "[REDACTED]";

function isRedactedKey(key) {
  return REDACT_KEYS.includes(String(key).toLowerCase());
}

/**
 * Deep copy with every sensitive value replaced by "[REDACTED]".
 * Recurses through objects and arrays; leaves primitives untouched.
 */
function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isRedactedKey(key) ? REDACTED : redact(item, seen);
  }
  return out;
}

/**
 * JSON.stringify that cannot throw: cycles become "[Circular]" and long arrays
 * are cut to MAX_ARRAY_ITEMS with a "…(+N more)" marker (a 300-student import
 * should not produce a 300-entry audit detail).
 */
function safeJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (key, val) => {
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
        if (Array.isArray(val) && val.length > MAX_ARRAY_ITEMS) {
          return [
            ...val.slice(0, MAX_ARRAY_ITEMS),
            `…(+${val.length - MAX_ARRAY_ITEMS} more)`,
          ];
        }
      }
      return val;
    });
  } catch {
    return "[unserializable]";
  }
}

/** Cuts `str` to `max` characters, marking that it was cut. */
function truncate(str, max = MAX_DETAIL_LENGTH) {
  const text = String(str ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * The one transformation applied to a request body before it is stored.
 *
 * Signature is `(body)` on purpose — it takes no path, no action, no route
 * hint. Anything route-shaped belongs in lib/auditActions.js.
 */
function summarizeBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "object" && Object.keys(body).length === 0) return "";
  return truncate(safeJson(redact(body)));
}

/**
 * Snapshot of a request body, taken the moment the middleware sees it.
 *
 * A plain reference is NOT enough: route handlers mutate req.body in place
 * (sanitizeCacheInput, handlers that attach fields before writing Firestore),
 * and the audit entry is built later in res.on("finish") — by then a reference
 * would show the post-processing state instead of what the user actually sent.
 */
function snapshotBody(body) {
  if (body === undefined || body === null) return null;
  try {
    return structuredClone(body);
  } catch {
    try {
      return JSON.parse(JSON.stringify(body));
    } catch {
      return null;
    }
  }
}

/** email → { name, id, at } cache, so repeated writes don't re-query Firestore. */
const actorCache = new Map();

/**
 * Looks up the teacher display name for an email.
 *
 * The result is stored ON the audit doc (not joined at read time), which keeps
 * the reader cheap and makes each entry a historical snapshot: renaming a
 * teacher later does not rewrite what old log lines say.
 */
async function resolveActor(db, email) {
  const key = String(email || "").toLowerCase();
  if (!key) return { name: null, id: null };

  const cached = actorCache.get(key);
  if (cached && Date.now() - cached.at < ACTOR_CACHE_TTL_MS) {
    return { name: cached.name, id: cached.id };
  }

  try {
    const snap = await db
      .collection("teachers")
      .where("gmail", "==", key)
      .limit(1)
      .get();
    const doc = snap.empty ? null : snap.docs[0];
    const resolved = {
      name: doc ? (doc.data().name ?? null) : null,
      id: doc ? doc.id : null,
    };
    actorCache.set(key, { ...resolved, at: Date.now() });
    return resolved;
  } catch (err) {
    console.error("[AUDIT] resolveActor failed:", err.message);
    return { name: null, id: null };
  }
}

/** Clears the actor name cache (used by tests). */
function clearActorCache() {
  actorCache.clear();
}

/**
 * Writes one audit entry. FIRE AND FORGET: never awaited by a request handler
 * and never allowed to throw, because a failure to log must not fail (or slow
 * down) the user's actual action.
 *
 * `entry.id` is optional. Give one when the same event may be recorded more
 * than once — a retried background step — so the retry overwrites the row
 * instead of adding a second one.
 */
function recordAudit(db, admin, entry) {
  try {
    const now = new Date();
    const expireAt = new Date(
      now.getTime() + AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const doc = {
      requestId: entry.requestId ?? null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expireAt: admin.firestore.Timestamp.fromDate(expireAt),
      actorEmail: entry.actorEmail ?? null,
      actorName: entry.actorName ?? null,
      actorId: entry.actorId ?? null,
      actorResolvedFrom: entry.actorResolvedFrom ?? "unknown",
      action: entry.action ?? "unknown",
      resourceType: entry.resourceType ?? "other",
      severity: entry.severity ?? "INFO",
      method: entry.method ?? null,
      path: entry.path ?? null,
      entityId: entry.entityId ?? null,
      statusCode: entry.statusCode ?? null,
      success: entry.success !== false,
      durationMs: entry.durationMs ?? null,
      detail: entry.detail ?? "",
      ip: entry.ip ?? null,
      userAgent: truncate(entry.userAgent ?? "", 200),
    };
    const logs = db.collection("auditLogs");
    return (entry.id ? logs.doc(String(entry.id)).set(doc) : logs.add(doc))
      .then(() => undefined)
      .catch((err) => console.error("[AUDIT] write failed:", err.message));
  } catch (err) {
    console.error("[AUDIT] recordAudit failed:", err.message);
    return Promise.resolve();
  }
}

module.exports = {
  ACTOR_CACHE_TTL_MS,
  AUDIT_RETENTION_DAYS,
  MAX_ARRAY_ITEMS,
  MAX_DETAIL_LENGTH,
  REDACT_KEYS,
  clearActorCache,
  recordAudit,
  redact,
  resolveActor,
  safeJson,
  snapshotBody,
  summarizeBody,
  truncate,
};
