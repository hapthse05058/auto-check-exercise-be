/**
 * The teacher's own Google identity for background grading jobs.
 *
 * A job keeps writing into student docs after the teacher has closed the tab,
 * so it cannot borrow the browser's access token. Instead the refresh token the
 * teacher's Google login already produces is kept here — encrypted — and turned
 * into a short-lived access token whenever a job needs one. Username/password
 * accounts have no Google identity at all; they write with the service account,
 * exactly as they always have.
 *
 * TOKEN HYGIENE. A refresh token is a long-lived credential for the teacher's
 * Drive, so:
 *   - it is stored only as AES-256-GCM ciphertext (random IV each time, auth
 *     tag checked), under a versioned key so the key can be rotated;
 *   - nothing here ever logs an error OBJECT from google-auth-library — its
 *     `config.data` carries the refresh token — only `describeError(err)`;
 *   - no route returns this collection.
 */
const crypto = require("crypto");

const COLLECTION = "teacherGoogleTokens";

/** Raised when the teacher must sign in with Google again. */
class ReauthRequiredError extends Error {
  constructor(message = "google_reauth_required") {
    super(message);
    this.name = "ReauthRequiredError";
    this.code = "google_reauth_required";
  }
}

/** Safe one-line description of a Google auth failure: never the token. */
function describeError(err) {
  const code = err?.response?.data?.error;
  const text = err?.response?.data?.error_description;
  return [code, text || err?.message].filter(Boolean).join(": ");
}

/**
 * Parses "v1:<base64>,v2:<base64>" into Map(version -> 32-byte key). A key that
 * is not exactly 32 bytes is a configuration error worth failing loudly on.
 */
function parseKeys(spec) {
  const keys = new Map();
  for (const part of String(spec || "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    if (at <= 0) throw new Error("GOOGLE_TOKEN_ENC_KEYS: expected version:key");
    const version = trimmed.slice(0, at);
    const key = Buffer.from(trimmed.slice(at + 1), "base64");
    if (key.length !== 32) {
      throw new Error(`GOOGLE_TOKEN_ENC_KEYS: key ${version} is not 32 bytes`);
    }
    keys.set(version, key);
  }
  return keys;
}

/**
 * AES-256-GCM box: { kv, iv, tag, ct }, all base64 except the key version.
 * `decrypt` returns null for anything it cannot authenticate (tampered data,
 * unknown or wrong key) — the caller treats that as "no token" and asks the
 * teacher to sign in again, rather than crashing a job.
 */
function createTokenCipher({ keys, current }) {
  if (!keys.has(current)) {
    throw new Error(`GOOGLE_TOKEN_ENC_KEY_CURRENT "${current}" has no key`);
  }

  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys.get(current), iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return {
      kv: current,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
  }

  function decrypt(box) {
    const key = box && keys.get(box.kv);
    if (!key) return null;
    try {
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(box.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(box.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(box.ct, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }

  return { current, decrypt, encrypt };
}

/**
 * @param deps.db, deps.admin            Firestore handles
 * @param deps.cipher                    createTokenCipher(...) result, or null
 *                                       when encryption is not configured (then
 *                                       nothing is stored and Google users are
 *                                       asked to use the service account path)
 * @param deps.createOAuthClient         () => OAuth2Client (for refreshing)
 * @param deps.getServiceAccountToken    () => Promise<string>
 * @param deps.now                       () => ms, injectable for tests
 */
function createGoogleUserTokens({
  db,
  admin,
  cipher,
  createOAuthClient,
  getServiceAccountToken,
  now = () => Date.now(),
}) {
  // email -> { token, expiresAt }. Per instance; losing it only costs a refresh.
  const accessCache = new Map();

  async function teacherIdFor(email) {
    const snap = await db
      .collection("teachers")
      .where("gmail", "==", String(email || "").toLowerCase())
      .limit(1)
      .get();
    return snap.empty ? null : snap.docs[0].id;
  }

  /** Stores (or replaces) the teacher's refresh token. Never throws. */
  async function saveRefreshToken(email, refreshToken) {
    if (!cipher || !refreshToken || !email) return false;
    try {
      const teacherId = await teacherIdFor(email);
      if (!teacherId) return false;
      await db
        .collection(COLLECTION)
        .doc(teacherId)
        .set({
          gmail: String(email).toLowerCase(),
          ...cipher.encrypt(refreshToken),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      return true;
    } catch (err) {
      console.error("[GOOGLE-TOKEN] save failed:", describeError(err));
      return false;
    }
  }

  async function loadRefreshToken(email) {
    if (!cipher) return null;
    const teacherId = await teacherIdFor(email);
    if (!teacherId) return null;
    const snap = await db.collection(COLLECTION).doc(teacherId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    const plain = cipher.decrypt(data);
    // Re-encrypt under the current key on first use after a rotation, so old
    // keys can be retired once every stored token has been touched.
    if (plain && data.kv !== cipher.current) {
      await snap.ref
        .set({ ...cipher.encrypt(plain) }, { merge: true })
        .catch(() => {});
    }
    return plain;
  }

  async function hasRefreshToken(email) {
    return Boolean(await loadRefreshToken(email));
  }

  /**
   * An access token that can edit student docs as this user.
   *
   * @param {string} email
   * @param {"google"|"jwt"} authKind  how the user signed in (see verifyToken)
   * @returns {Promise<{token: string, isServiceAccount: boolean}>}
   * @throws {ReauthRequiredError} Google user without a usable refresh token
   */
  async function getDocsAccessToken(email, authKind) {
    if (authKind !== "google") {
      return { token: await getServiceAccountToken(), isServiceAccount: true };
    }
    const key = String(email || "").toLowerCase();
    const cached = accessCache.get(key);
    if (cached && cached.expiresAt - now() > 120000) {
      return { token: cached.token, isServiceAccount: false };
    }

    const refreshToken = await loadRefreshToken(key);
    if (!refreshToken) throw new ReauthRequiredError();

    const client = createOAuthClient();
    client.setCredentials({ refresh_token: refreshToken });
    let credentials;
    try {
      ({ credentials } = await client.refreshAccessToken());
    } catch (err) {
      if (err?.response?.data?.error === "invalid_grant") {
        // Revoked, expired, or the password changed — only the teacher can
        // fix it. Drop the dead token so the next job fails fast.
        accessCache.delete(key);
        throw new ReauthRequiredError();
      }
      // Anything else (network, Google 5xx) is worth a retry. Rethrow a clean
      // error: the original carries the refresh token in err.config.data.
      const clean = new Error(
        `google token refresh failed: ${describeError(err)}`,
      );
      clean.transient = true;
      throw clean;
    }

    accessCache.set(key, {
      token: credentials.access_token,
      expiresAt: credentials.expiry_date || now() + 3600 * 1000,
    });
    // Google may rotate the refresh token; keep the newest one.
    if (
      credentials.refresh_token &&
      credentials.refresh_token !== refreshToken
    ) {
      await saveRefreshToken(key, credentials.refresh_token);
    }
    return { token: credentials.access_token, isServiceAccount: false };
  }

  /** Forgets a cached access token Google has just refused (a 401). */
  function invalidate(email) {
    accessCache.delete(String(email || "").toLowerCase());
  }

  return { getDocsAccessToken, hasRefreshToken, invalidate, saveRefreshToken };
}

module.exports = {
  COLLECTION,
  ReauthRequiredError,
  createGoogleUserTokens,
  createTokenCipher,
  describeError,
  parseKeys,
};
