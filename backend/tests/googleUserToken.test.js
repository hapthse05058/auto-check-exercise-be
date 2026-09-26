const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { describe, it } = require("node:test");

const {
  ReauthRequiredError,
  createGoogleUserTokens,
  createTokenCipher,
  parseKeys,
} = require("../lib/googleUserToken.js");
const {
  FakeFirestore,
  createFakeAdmin,
} = require("./helpers/fakeFirestore.js");

const key = () => crypto.randomBytes(32).toString("base64");
const REFRESH = "1//0g-very-secret-refresh-token";

function setup({ spec = `v1:${key()}`, current = "v1", refresh } = {}) {
  const db = new FakeFirestore();
  const admin = createFakeAdmin();
  db._apply({
    type: "set",
    path: "teachers/t1",
    data: { gmail: "teacher@x.com", name: "Cô Hà" },
  });
  const keys = parseKeys(spec);
  const cipher = createTokenCipher({ keys, current });
  const oauth = { calls: 0, refresh };
  const tokens = createGoogleUserTokens({
    db,
    admin,
    cipher,
    createOAuthClient: () => ({
      setCredentials(c) {
        oauth.lastRefreshToken = c.refresh_token;
      },
      async refreshAccessToken() {
        oauth.calls += 1;
        if (oauth.refresh) return oauth.refresh();
        return {
          credentials: {
            access_token: `access-${oauth.calls}`,
            expiry_date: Date.now() + 3600 * 1000,
          },
        };
      },
    }),
    getServiceAccountToken: async () => "service-account-token",
  });
  return { db, cipher, tokens, oauth, keys };
}

/** Everything console.* prints while `fn` runs. */
/* eslint-disable no-console -- swapping console.* out is the point here */
async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const level of ["log", "warn", "error"]) {
    saved[level] = console[level];
    console[level] = (...args) =>
      lines.push(
        args
          .map((a) =>
            typeof a === "string"
              ? a
              : (JSON.stringify(a, null, 0) ?? String(a)),
          )
          .join(" "),
      );
  }
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}
/* eslint-enable no-console */

describe("token cipher", () => {
  it("round-trips, with a fresh IV every time", () => {
    const { cipher } = setup();
    const a = cipher.encrypt(REFRESH);
    const b = cipher.encrypt(REFRESH);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
    assert.equal(cipher.decrypt(a), REFRESH);
    assert.ok(!JSON.stringify(a).includes(REFRESH));
  });

  it("refuses tampered ciphertext, a tampered tag and the wrong key", () => {
    const { cipher } = setup();
    const box = cipher.encrypt(REFRESH);
    const flip = (b64) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] ^= 1;
      return buf.toString("base64");
    };
    assert.equal(cipher.decrypt({ ...box, ct: flip(box.ct) }), null);
    assert.equal(cipher.decrypt({ ...box, tag: flip(box.tag) }), null);
    const other = createTokenCipher({
      keys: parseKeys(`v1:${key()}`),
      current: "v1",
    });
    assert.equal(other.decrypt(box), null);
    assert.equal(cipher.decrypt({ ...box, kv: "v9" }), null);
  });

  it("rejects keys that are not 32 bytes", () => {
    assert.throws(() => parseKeys("v1:c2hvcnQ="), /32 bytes/);
    assert.throws(() => parseKeys("nokey"), /version:key/);
  });
});

describe("stored refresh tokens", () => {
  it("stores only ciphertext, and turns it into an access token", async () => {
    const { db, tokens, oauth } = setup();
    assert.equal(await tokens.saveRefreshToken("Teacher@x.com", REFRESH), true);
    const stored = db.dump("teacherGoogleTokens").t1;
    assert.ok(!JSON.stringify(stored).includes(REFRESH));
    assert.equal(stored.gmail, "teacher@x.com");

    const access = await tokens.getDocsAccessToken("teacher@x.com", "google");
    assert.deepEqual(access, { token: "access-1", isServiceAccount: false });
    assert.equal(oauth.lastRefreshToken, REFRESH);
    // Cached until close to expiry.
    await tokens.getDocsAccessToken("teacher@x.com", "google");
    assert.equal(oauth.calls, 1);
  });

  it("username/password accounts always get the service account", async () => {
    const { tokens, oauth } = setup();
    assert.deepEqual(await tokens.getDocsAccessToken("teacher@x.com", "jwt"), {
      token: "service-account-token",
      isServiceAccount: true,
    });
    assert.equal(oauth.calls, 0);
  });

  it("no stored token, or a revoked grant, means sign in again", async () => {
    const { tokens } = setup({
      refresh: async () => {
        const err = new Error("invalid_grant");
        err.response = { data: { error: "invalid_grant" } };
        throw err;
      },
    });
    await assert.rejects(
      tokens.getDocsAccessToken("teacher@x.com", "google"),
      ReauthRequiredError,
    );
    await tokens.saveRefreshToken("teacher@x.com", REFRESH);
    await assert.rejects(
      tokens.getDocsAccessToken("teacher@x.com", "google"),
      ReauthRequiredError,
    );
  });

  it("does not store tokens for someone who is not a teacher", async () => {
    const { db, tokens } = setup();
    assert.equal(
      await tokens.saveRefreshToken("stranger@x.com", REFRESH),
      false,
    );
    assert.deepEqual(db.dump("teacherGoogleTokens"), {});
  });

  it("keeps working across a key rotation and re-encrypts under the new key", async () => {
    const k1 = key();
    const k2 = key();
    const before = setup({ spec: `v1:${k1}` });
    await before.tokens.saveRefreshToken("teacher@x.com", REFRESH);
    const stored = before.db.dump("teacherGoogleTokens").t1;

    // Deploy with v2 as current; v1 still listed for reading.
    const after = setup({ spec: `v1:${k1},v2:${k2}`, current: "v2" });
    after.db._apply({
      type: "set",
      path: "teacherGoogleTokens/t1",
      data: stored,
    });
    assert.equal(
      (await after.tokens.getDocsAccessToken("teacher@x.com", "google")).token,
      "access-1",
    );
    assert.equal(after.oauth.lastRefreshToken, REFRESH);
    assert.equal(after.db.dump("teacherGoogleTokens").t1.kv, "v2");
  });
});

describe("the refresh token never leaks", () => {
  it("not through the error of a failed refresh, nor the console", async () => {
    const { tokens } = setup({
      refresh: async () => {
        // What gaxios really throws: the request body rides along in config.
        const err = new Error("request to oauth2.googleapis.com failed");
        err.config = {
          data: `refresh_token=${REFRESH}&grant_type=refresh_token`,
        };
        err.response = { data: { error: "server_error" } };
        throw err;
      },
    });
    await tokens.saveRefreshToken("teacher@x.com", REFRESH);
    let thrown;
    const output = await captureConsole(async () => {
      thrown = await tokens
        .getDocsAccessToken("teacher@x.com", "google")
        .catch((e) => e);
    });
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.transient, true);
    assert.ok(!thrown.message.includes(REFRESH));
    assert.ok(!JSON.stringify(thrown).includes(REFRESH));
    assert.equal(thrown.config, undefined);
    assert.ok(!output.includes(REFRESH));
  });

  it("not through the console when storing fails", async () => {
    const { db, tokens } = setup();
    const original = db.collection.bind(db);
    db.collection = (name) => {
      if (name !== "teacherGoogleTokens") return original(name);
      const col = original(name);
      return {
        doc: (id) => ({
          ...col.doc(id),
          set: async () => {
            const err = new Error("PERMISSION_DENIED");
            err.config = { data: REFRESH };
            throw err;
          },
        }),
      };
    };
    const output = await captureConsole(async () => {
      assert.equal(
        await tokens.saveRefreshToken("teacher@x.com", REFRESH),
        false,
      );
    });
    assert.match(output, /save failed/);
    assert.ok(!output.includes(REFRESH));
  });
});
