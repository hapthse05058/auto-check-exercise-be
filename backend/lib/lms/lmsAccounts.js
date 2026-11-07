/**
 * A teacher's SEC LMS login, kept so grading jobs can read and save drafts
 * after the teacher has closed the tab.
 *
 * CREDENTIAL HYGIENE (same rules as lib/googleUserToken.js):
 *   - the password and the LMS token are stored only as AES-256-GCM
 *     ciphertext (createTokenCipher), under their own versioned keys
 *     (LMS_CRED_ENC_KEYS / LMS_CRED_ENC_KEY_CURRENT);
 *   - status() is the only read a route exposes: phone, LMS name, state —
 *     never the password or the token;
 *   - errors are logged as their code only.
 *
 * lmsAccounts/{teacherId}:
 *   { phone, password: box, token: box|null, tokenExpiresAt, lmsUserId,
 *     lmsName, status: "ok"|"needs_relogin", linkedAt, updatedAt }
 */
const { LmsError } = require("./lmsClient.js");

const COLLECTION = "lmsAccounts";
/** A token this close to expiry is renewed before use. */
const TOKEN_MARGIN_MS = 10 * 60 * 1000;

/** The teacher must link the LMS account again (captcha, new password…). */
class LmsReloginRequired extends Error {
  constructor(reason) {
    super("lms_relogin_required");
    this.name = "LmsReloginRequired";
    this.code = "lms_relogin_required";
    this.reason = reason;
  }
}

/**
 * @param deps.db, deps.admin
 * @param deps.cipher   createTokenCipher(...) or null (not configured)
 * @param deps.client   createLmsClient(...)
 * @param deps.now      () => ms
 */
function createLmsAccounts({ db, admin, cipher, client, now = Date.now }) {
  const ref = (teacherId) => db.collection(COLLECTION).doc(String(teacherId));
  const serverTime = () => admin.firestore.FieldValue.serverTimestamp();

  function requireCipher() {
    if (!cipher) {
      const err = new Error("lms_not_configured");
      err.code = "lms_not_configured";
      throw err;
    }
  }

  /** Logs in once to prove the credentials, then stores them encrypted. */
  async function link(teacherId, { phone, password }) {
    requireCipher();
    const session = await client.login(phone, password); // throws LmsError
    const record = {
      phone: String(phone).trim(),
      password: cipher.encrypt(String(password)),
      token: cipher.encrypt(session.token),
      tokenExpiresAt: session.expiresAt,
      lmsUserId: session.user.id,
      lmsName: session.user.name,
      status: "ok",
      linkedAt: serverTime(),
      updatedAt: serverTime(),
    };
    await ref(teacherId).set(record);
    return { phone: record.phone, lmsName: record.lmsName, status: "ok" };
  }

  /** Removes the record — password and token included. */
  async function unlink(teacherId) {
    await ref(teacherId).delete();
  }

  /** What a route may show. */
  async function status(teacherId) {
    const snap = await ref(teacherId).get();
    if (!snap.exists) return { linked: false };
    const data = snap.data();
    return {
      linked: true,
      phone: data.phone,
      lmsName: data.lmsName || "",
      status: data.status || "ok",
    };
  }

  /**
   * Token source for lmsClient.forTeacher: a stored token while it is fresh,
   * else a new login with the stored password.
   */
  function tokenSource(teacherId) {
    let cached = null;

    async function refresh() {
      requireCipher();
      const snap = await ref(teacherId).get();
      if (!snap.exists) throw new LmsReloginRequired("not_linked");
      const data = snap.data();
      // Mark the account so the settings page asks for the password again
      // (status() would otherwise keep saying "linked").
      const requireRelogin = async (reason) => {
        await ref(teacherId).update({
          status: "needs_relogin",
          token: null,
          updatedAt: serverTime(),
        });
        throw new LmsReloginRequired(reason);
      };
      // Undecryptable: the encryption key was rotated away or changed.
      const password = cipher.decrypt(data.password);
      if (!password) return requireRelogin("undecryptable");
      let session;
      try {
        session = await client.login(data.phone, password);
      } catch (err) {
        if (
          err instanceof LmsError &&
          (err.code === "captcha_required" || err.code === "bad_credentials")
        ) {
          return requireRelogin(err.code);
        }
        throw err;
      }
      await ref(teacherId).update({
        token: cipher.encrypt(session.token),
        tokenExpiresAt: session.expiresAt,
        lmsName: session.user.name || data.lmsName || "",
        status: "ok",
        updatedAt: serverTime(),
      });
      cached = session.token;
      return cached;
    }

    async function get() {
      if (cached) return cached;
      requireCipher();
      const snap = await ref(teacherId).get();
      if (!snap.exists) throw new LmsReloginRequired("not_linked");
      const data = snap.data();
      if (data.status === "needs_relogin") {
        throw new LmsReloginRequired("needs_relogin");
      }
      const token = data.token ? cipher.decrypt(data.token) : null;
      const fresh =
        token &&
        Number.isFinite(data.tokenExpiresAt) &&
        data.tokenExpiresAt - TOKEN_MARGIN_MS > now();
      if (fresh) {
        cached = token;
        return cached;
      }
      return refresh();
    }

    return { get, refresh };
  }

  return { link, status, tokenSource, unlink };
}

module.exports = { COLLECTION, LmsReloginRequired, createLmsAccounts };
