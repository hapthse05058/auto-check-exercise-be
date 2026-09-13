/**
 * FCM web-push device registry + sender.
 *
 * No new dependency: firebase-admin is already initialised in lib/firestore.js
 * from the same service account, and `admin.messaging()` mints FCM v1
 * credentials from it. The Firebase console only has to have Cloud Messaging
 * enabled and a Web Push (VAPID) key pair generated for the browser side.
 *
 * Tokens live in a FLAT top-level `fcmTokens` collection rather than under
 * `teachers`, because an admin is identified by an email allow-list and may not
 * have a teacher document at all; a flat collection also lets listActiveTokens
 * fetch every admin's devices with one `where("email", "in", ...)` query.
 *
 * The document id is sha256(token). That makes re-registering the same browser
 * an idempotent merge instead of a new row (the client re-asserts its token on
 * every app start), and it gives us a short, URL-safe, log-safe handle for the
 * unregister route — the raw token never appears in a URL or an audit entry.
 */
const crypto = require("crypto");

const COLLECTION = "fcmTokens";

/** FCM caps a multicast at 500 tokens per call. */
const SEND_CHUNK = 500;

/** Consecutive soft failures before a token is dropped anyway. */
const MAX_SOFT_FAILURES = 5;

/**
 * Error codes that mean the token is permanently dead — the browser revoked the
 * subscription, the app was uninstalled, the token was rotated. These are the
 * only ones we delete on: a transient server-side error must not throw away a
 * device the admin still uses.
 */
const PRUNE_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/** Deterministic, non-reversible handle for a token. */
function tokenDocId(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** "prune" (token is dead) vs "retry" (transient). Pure — unit tested. */
function classifySendError(code) {
  return PRUNE_CODES.has(String(code || "")) ? "prune" : "retry";
}

/**
 * Registers or refreshes one device token.
 * Idempotent: the same token from the same browser only bumps `lastSeenAt`.
 */
async function saveDevice(
  db,
  admin,
  { token, email, teacherId, userAgent, platform },
) {
  const tokenHash = tokenDocId(token);
  const ref = db.collection(COLLECTION).doc(tokenHash);
  const existing = await ref.get();
  const now = admin.firestore.Timestamp.now();

  await ref.set(
    {
      token,
      tokenHash,
      email: String(email || "").toLowerCase(),
      teacherId: teacherId || null,
      userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
      platform: platform ? String(platform).slice(0, 60) : null,
      createdAt: existing.exists ? existing.data()?.createdAt || now : now,
      lastSeenAt: now,
      failureCount: 0,
      disabledAt: null,
      disabledReason: null,
    },
    { merge: true },
  );

  return { tokenHash, created: !existing.exists };
}

/** Every registered device belonging to any of `emails`. */
async function listActiveTokens(db, emails) {
  const wanted = (emails || [])
    .map((e) => String(e).toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return [];

  const devices = [];
  // Firestore caps an `in` filter at 30 values; chunk defensively.
  const CHUNK = 30;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const snap = await db
      .collection(COLLECTION)
      .where("email", "in", wanted.slice(i, i + CHUNK))
      .get();
    snap.docs.forEach((doc) => {
      const data = doc.data() || {};
      if (data.token) {
        devices.push({ id: doc.id, token: data.token, email: data.email });
      }
    });
  }
  return devices;
}

/** Unregisters one device. False when it does not exist or belongs elsewhere. */
async function removeDevice(db, tokenHash, email) {
  const ref = db.collection(COLLECTION).doc(String(tokenHash));
  const snap = await ref.get();
  if (!snap.exists) return false;
  const owner = String(snap.data()?.email || "").toLowerCase();
  if (owner && owner !== String(email || "").toLowerCase()) return false;
  await ref.delete();
  return true;
}

/**
 * Sends one notification to every given device and prunes dead tokens.
 *
 * NEVER throws: push is the best-effort half of the alert. The in-app
 * notification is already stored by the time this runs, so a Firebase outage or
 * a misconfigured console must not take the alert path down with it.
 */
async function sendPush(admin, db, { tokens, title, body, data = {}, link }) {
  const result = { successCount: 0, failureCount: 0, pruned: 0, error: null };
  const devices = (tokens || []).filter((d) => d && d.token);
  if (devices.length === 0) return result;

  try {
    const messaging = admin.messaging();
    const toPrune = [];
    const toPenalise = [];

    for (let i = 0; i < devices.length; i += SEND_CHUNK) {
      const chunk = devices.slice(i, i + SEND_CHUNK);
      const response = await messaging.sendEachForMulticast({
        tokens: chunk.map((d) => d.token),
        notification: { title, body },
        // FCM data values must all be strings.
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v ?? "")]),
        ),
        webpush: {
          notification: { title, body, icon: "/check-exercise.png" },
          fcmOptions: link ? { link } : undefined,
        },
      });

      result.successCount += response.successCount;
      result.failureCount += response.failureCount;

      response.responses.forEach((res, index) => {
        if (res.success) return;
        const code = res.error?.code;
        if (classifySendError(code) === "prune") {
          toPrune.push(chunk[index].id);
        } else {
          toPenalise.push({ id: chunk[index].id, code });
        }
      });
    }

    if (toPrune.length > 0) {
      const batch = db.batch();
      toPrune.forEach((id) => batch.delete(db.collection(COLLECTION).doc(id)));
      await batch.commit();
      result.pruned = toPrune.length;
    }

    // A soft failure only counts against the token; it is deleted once it has
    // failed MAX_SOFT_FAILURES times in a row without ever succeeding.
    for (const { id, code } of toPenalise) {
      const ref = db.collection(COLLECTION).doc(id);
      const snap = await ref.get();
      const failureCount = (snap.data()?.failureCount || 0) + 1;
      if (failureCount >= MAX_SOFT_FAILURES) {
        await ref.delete();
        result.pruned += 1;
      } else {
        await ref.update({ failureCount, disabledReason: code || null });
      }
    }
  } catch (err) {
    // Swallowed on purpose — see the doc comment above.
    result.error = err.message || "push_failed";
    console.error("[PUSH] send failed:", err.message);
  }

  return result;
}

module.exports = {
  COLLECTION,
  MAX_SOFT_FAILURES,
  PRUNE_CODES,
  SEND_CHUNK,
  classifySendError,
  listActiveTokens,
  removeDevice,
  saveDevice,
  sendPush,
  tokenDocId,
};
