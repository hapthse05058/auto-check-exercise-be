const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  LmsError,
  createLmsClient,
  jwtExpiryMs,
} = require("../lib/lms/lmsClient.js");
const {
  createLmsAccounts,
  LmsReloginRequired,
} = require("../lib/lms/lmsAccounts.js");
const { createTokenCipher } = require("../lib/googleUserToken.js");
const {
  FakeFirestore,
  createFakeAdmin,
} = require("./helpers/fakeFirestore.js");

/** A JWT-looking token with the given exp (seconds). */
const jwt = (exp) =>
  `h.${Buffer.from(JSON.stringify({ sub: "1", exp })).toString("base64url")}.s`;

/** fetch stub: a queue of responses (or functions/errors) per path prefix. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({
      path,
      method: init.method,
      auth: init.headers.Authorization,
      body: init.body,
    });
    const key = Object.keys(routes).find((p) => path.startsWith(p));
    const queue = routes[key];
    if (!queue || !queue.length) throw new Error(`unexpected call ${path}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    const r = typeof next === "function" ? next(init) : next;
    return {
      status: r.status ?? 200,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null },
      text: async () =>
        typeof r.body === "string" ? r.body : JSON.stringify(r.body),
    };
  };
  return { impl, calls };
}

const ok = (data) => ({ body: { statusCode: 200, data } });
const noSleep = async () => {};

function client(routes) {
  const f = fakeFetch(routes);
  return {
    c: createLmsClient({
      fetchImpl: f.impl,
      sleep: noSleep,
      baseUrl: "https://lms",
    }),
    calls: f.calls,
  };
}

describe("login", () => {
  test("returns the token, its expiry and the LMS user", async () => {
    const token = jwt(2000000000);
    const { c } = client({
      "/api/auth/v1/captcha-required": [ok(false)],
      "/api/auth/v1/login": [
        ok({ token, user: { id: 279, fullName: "GV A" } }),
      ],
    });
    const s = await c.login("0900000000", "pw");
    assert.equal(s.token, token);
    assert.equal(s.expiresAt, 2000000000 * 1000);
    assert.deepEqual(s.user, { id: 279, name: "GV A" });
  });

  test("captcha required: stop before sending the password", async () => {
    const { c, calls } = client({
      "/api/auth/v1/captcha-required": [ok(true)],
    });
    await assert.rejects(
      c.login("0900000000", "pw"),
      (e) => e.code === "captcha_required",
    );
    assert.ok(!calls.some((x) => x.path.startsWith("/api/auth/v1/login")));
  });

  test("a refused login is bad_credentials and is not retried", async () => {
    const { c, calls } = client({
      "/api/auth/v1/captcha-required": [ok(false)],
      "/api/auth/v1/login": [
        { body: { statusCode: 422, message: "Sai mật khẩu" } },
      ],
    });
    await assert.rejects(
      c.login("0900000000", "x"),
      (e) => e.code === "bad_credentials",
    );
    assert.equal(
      calls.filter((x) => x.path === "/api/auth/v1/login").length,
      1,
    );
  });

  test("LMS down during login is lms_unavailable, not bad credentials", async () => {
    const { c } = client({
      "/api/auth/v1/captcha-required": [ok(false)],
      "/api/auth/v1/login": [{ status: 502, body: "bad gateway" }],
    });
    await assert.rejects(
      c.login("0900000000", "pw"),
      (e) => e.code === "lms_unavailable",
    );
  });
});

describe("teacher API retry rules", () => {
  const tokens = () => {
    let n = 0;
    return { get: async () => "t1", refresh: async () => `t${(n += 1) + 1}` };
  };

  test("401 → one new login, then the call is repeated", async () => {
    const { c, calls } = client({
      "/api/class/v1/role": [
        { body: { statusCode: 401 } },
        ok({ content: [{ id: 7 }] }),
      ],
    });
    const classes = await c.forTeacher(tokens()).listClasses();
    assert.deepEqual(classes, [{ id: 7 }]);
    assert.deepEqual(
      calls.map((x) => x.auth),
      ["Bearer t1", "Bearer t2"],
    );
  });

  test("a second 401 after the new login is an error, not a loop", async () => {
    const { c, calls } = client({
      "/api/class/v1/role": [{ body: { statusCode: 401 } }],
    });
    await assert.rejects(
      c.forTeacher(tokens()).listClasses(),
      (e) => e.code === "unauthorized",
    );
    assert.equal(calls.length, 2);
  });

  test("429 waits Retry-After and repeats (even a PUT: it did not land)", async () => {
    const waits = [];
    const f = fakeFetch({
      "/api/score-report": [
        { status: 429, headers: { "retry-after": "3" }, body: "" },
        ok(null),
      ],
    });
    const c = createLmsClient({
      fetchImpl: f.impl,
      sleep: async (ms) => waits.push(ms),
      baseUrl: "https://lms",
    });
    await c.forTeacher(tokens()).saveDraft(7, 477, 119, []);
    assert.deepEqual(waits, [3000]);
    assert.equal(f.calls.length, 2);
  });

  test("GET: 5xx and network errors are retried, then lms_unavailable", async () => {
    const { c, calls } = client({
      "/api/assignment/v1/class/7": [
        { status: 500, body: "x" },
        new Error("ECONNRESET"),
        ok([{ id: 477 }]),
      ],
    });
    assert.deepEqual(await c.forTeacher(tokens()).listSessions(7), [
      { id: 477 },
    ]);
    assert.equal(calls.length, 3);
    const down = client({
      "/api/assignment/v1/class/7": [{ status: 503, body: "x" }],
    });
    await assert.rejects(
      down.c.forTeacher(tokens()).listSessions(7),
      (e) => e.code === "lms_unavailable",
    );
    assert.equal(down.calls.length, 3);
  });

  test("PUT: a 5xx or a timeout is write_uncertain and is NOT repeated", async () => {
    const a = client({ "/api/score-report": [{ status: 500, body: "x" }] });
    await assert.rejects(
      a.c.forTeacher(tokens()).saveDraft(7, 477, 119, []),
      (e) => e.code === "write_uncertain",
    );
    assert.equal(a.calls.length, 1);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const b = client({ "/api/score-report": [abort] });
    await assert.rejects(
      b.c.forTeacher(tokens()).saveDraft(7, 477, 119, []),
      (e) => e.code === "write_uncertain",
    );
    assert.equal(b.calls.length, 1);
  });

  test("403 inside a 200 is forbidden", async () => {
    const { c } = client({
      "/api/class/v1/role": [
        { body: { statusCode: 403, message: "Forbidden" } },
      ],
    });
    await assert.rejects(
      c.forTeacher(tokens()).listClasses(),
      (e) => e instanceof LmsError && e.code === "forbidden",
    );
  });

  test("saveDraft uses the draft URL, never .../submit", async () => {
    const { c, calls } = client({ "/api/score-report": [ok(null)] });
    await c.forTeacher(tokens()).saveDraft(7, 477, 119, [{ assignmentId: 1 }]);
    assert.equal(calls[0].method, "PUT");
    assert.equal(
      calls[0].path,
      "/api/score-report/v1/class/7/session/477/grading/119/assignment",
    );
    assert.ok(!calls[0].path.includes("submit"));
  });
});

test("jwtExpiryMs reads exp, tolerates junk", () => {
  assert.equal(jwtExpiryMs(jwt(10)), 10000);
  assert.equal(jwtExpiryMs("nope"), null);
});

describe("lmsAccounts", () => {
  const cipher = createTokenCipher({
    keys: new Map([["v1", Buffer.alloc(32, 7)]]),
    current: "v1",
  });

  function setup({ loginImpl, now = () => 1000 } = {}) {
    const db = new FakeFirestore();
    const logins = [];
    const fakeClient = {
      login: async (phone, password) => {
        logins.push({ phone, password });
        return loginImpl
          ? loginImpl(phone, password)
          : {
              token: `tok-${logins.length}`,
              expiresAt: now() + 24 * 3600 * 1000,
              user: { id: 1, name: "GV A" },
            };
      },
    };
    const accounts = createLmsAccounts({
      db,
      admin: createFakeAdmin(),
      cipher,
      client: fakeClient,
      now,
    });
    return { db, accounts, logins };
  }

  test("link stores only ciphertext; status never returns secrets", async () => {
    const { db, accounts } = setup();
    await accounts.link("t1", { phone: " 0900000000 ", password: "secret-pw" });
    const stored = JSON.stringify(db.dump("lmsAccounts"));
    assert.ok(!stored.includes("secret-pw"));
    assert.ok(!stored.includes("tok-1"));
    const status = await accounts.status("t1");
    assert.deepEqual(status, {
      linked: true,
      phone: "0900000000",
      lmsName: "GV A",
      status: "ok",
    });
  });

  test("a fresh stored token is used without logging in again", async () => {
    const { accounts, logins } = setup();
    await accounts.link("t1", { phone: "0900000000", password: "pw" });
    const source = accounts.tokenSource("t1");
    assert.equal(await source.get(), "tok-1");
    assert.equal(logins.length, 1);
  });

  test("an expired token is renewed with the stored password", async () => {
    let t = 1000;
    const { accounts, logins } = setup({ now: () => t });
    await accounts.link("t1", { phone: "0900000000", password: "pw" });
    t += 25 * 3600 * 1000;
    assert.equal(await accounts.tokenSource("t1").get(), "tok-2");
    assert.deepEqual(logins[1], { phone: "0900000000", password: "pw" });
  });

  test("captcha on renewal → needs_relogin, no further logins", async () => {
    let fail = false;
    const { accounts, logins } = setup({
      loginImpl: () => {
        if (fail) throw new LmsError("captcha_required");
        return { token: "tok", expiresAt: 0, user: { id: 1, name: "A" } };
      },
    });
    await accounts.link("t1", { phone: "0900000000", password: "pw" });
    fail = true;
    await assert.rejects(
      accounts.tokenSource("t1").get(),
      (e) => e instanceof LmsReloginRequired,
    );
    assert.equal((await accounts.status("t1")).status, "needs_relogin");
    const before = logins.length;
    await assert.rejects(
      accounts.tokenSource("t1").get(),
      (e) => e instanceof LmsReloginRequired,
    );
    assert.equal(logins.length, before);
  });

  test("unlink deletes the record", async () => {
    const { accounts, db } = setup();
    await accounts.link("t1", { phone: "0900000000", password: "pw" });
    await accounts.unlink("t1");
    assert.deepEqual(await accounts.status("t1"), { linked: false });
    assert.equal(Object.keys(db.dump("lmsAccounts")).length, 0);
  });

  test("link with wrong credentials stores nothing", async () => {
    const { accounts, db } = setup({
      loginImpl: () => {
        throw new LmsError("bad_credentials");
      },
    });
    await assert.rejects(
      accounts.link("t1", { phone: "0900000000", password: "x" }),
      (e) => e.code === "bad_credentials",
    );
    assert.equal(Object.keys(db.dump("lmsAccounts")).length, 0);
  });
});
