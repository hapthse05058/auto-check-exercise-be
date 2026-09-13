const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  balanceUrl,
  decideAlert,
  describeAlert,
  evaluateBalance,
  failedEvaluation,
  fetchBalance,
  initialState,
  parseBalanceResponse,
  readPolicy,
  readThresholds,
} = require("../lib/deepseekBalance.js");

const HOUR = 3600000;
const POLICY = {
  enabled: true,
  checkIntervalMs: 60 * 60000,
  reAlertMs: 24 * HOUR,
  hysteresis: 0.2,
  notifyRecovery: true,
  timeoutMs: 8000,
  errorAlertAfter: 3,
};

/** The exact payload shape the DeepSeek docs publish. */
const DOC_SAMPLE = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
};

// ---------------------------------------------------------------------------
// balanceUrl
// ---------------------------------------------------------------------------

test("balanceUrl: default base", () => {
  assert.equal(balanceUrl(undefined), "https://api.deepseek.com/user/balance");
});

test("balanceUrl: strips trailing slash and /v1 (balance is not under /v1)", () => {
  assert.equal(
    balanceUrl("https://api.deepseek.com/"),
    "https://api.deepseek.com/user/balance",
  );
  assert.equal(
    balanceUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/user/balance",
  );
});

test("balanceUrl: an explicit URL always wins", () => {
  assert.equal(
    balanceUrl("https://api.deepseek.com", "https://proxy.local/bal"),
    "https://proxy.local/bal",
  );
});

// ---------------------------------------------------------------------------
// parseBalanceResponse
// ---------------------------------------------------------------------------

test("parseBalanceResponse: coerces string amounts", () => {
  const parsed = parseBalanceResponse(DOC_SAMPLE);
  assert.equal(parsed.isAvailable, true);
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.balances, [
    {
      currency: "CNY",
      totalBalance: 110,
      grantedBalance: 10,
      toppedUpBalance: 100,
    },
  ]);
});

test("parseBalanceResponse: sorts by currency so order is deterministic", () => {
  const usdFirst = parseBalanceResponse({
    is_available: true,
    balance_infos: [
      { currency: "USD", total_balance: "1.00" },
      { currency: "CNY", total_balance: "2.00" },
    ],
  });
  const cnyFirst = parseBalanceResponse({
    is_available: true,
    balance_infos: [
      { currency: "CNY", total_balance: "2.00" },
      { currency: "USD", total_balance: "1.00" },
    ],
  });
  assert.deepEqual(
    usdFirst.balances.map((b) => b.currency),
    ["CNY", "USD"],
  );
  assert.deepEqual(usdFirst.balances, cnyFirst.balances);
});

test("parseBalanceResponse: a non-numeric amount is dropped, not read as 0", () => {
  const parsed = parseBalanceResponse({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "not-a-number" }],
  });
  assert.equal(parsed.balances.length, 0);
  assert.equal(parsed.malformed, true);
});

test("parseBalanceResponse: is_available false is carried through", () => {
  const parsed = parseBalanceResponse({
    is_available: false,
    balance_infos: [],
  });
  assert.equal(parsed.isAvailable, false);
});

// ---------------------------------------------------------------------------
// evaluateBalance
// ---------------------------------------------------------------------------

test("evaluateBalance: above threshold is ok", () => {
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "2.99" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.ok, true);
  assert.equal(result.isLow, false);
  assert.equal(result.reason, "ok");
  assert.equal(result.fingerprint, "ok");
});

test("evaluateBalance: below threshold is low, with the threshold attached", () => {
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "0.42" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.isLow, true);
  assert.equal(result.reason, "low");
  assert.equal(result.fingerprint, "low:USD");
  assert.equal(result.primary.threshold, 1);
  assert.equal(result.primary.totalBalance, 0.42);
});

test("evaluateBalance: exactly at the threshold is NOT low (strict <)", () => {
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "1.00" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.isLow, false);
});

test("evaluateBalance: each currency uses its own threshold", () => {
  const thresholds = { USD: 1, CNY: 8, fallback: null };
  // 5 CNY is below the CNY threshold even though 5 > the USD threshold.
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "5" }],
    },
    thresholds,
  );
  assert.equal(result.isLow, true);
  assert.equal(result.fingerprint, "low:CNY");
});

test("evaluateBalance: both currencies low -> sorted composite fingerprint", () => {
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "0.10" },
        { currency: "CNY", total_balance: "1.00" },
      ],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.fingerprint, "low:CNY+USD");
  assert.equal(result.breaches.length, 2);
});

test("evaluateBalance: array order does NOT change the fingerprint", () => {
  const thresholds = { USD: 1, CNY: 8, fallback: null };
  const a = evaluateBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "0.10" },
        { currency: "CNY", total_balance: "1.00" },
      ],
    },
    thresholds,
  );
  const b = evaluateBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "1.00" },
        { currency: "USD", total_balance: "0.10" },
      ],
    },
    thresholds,
  );
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.primary, b.primary);
});

test("evaluateBalance: an unconfigured currency is skipped, never judged low", () => {
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "EUR", total_balance: "0.01" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.isLow, false);
  assert.deepEqual(result.skipped, ["EUR"]);
});

test("evaluateBalance: fallback threshold covers an unlisted currency", () => {
  const result = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "EUR", total_balance: "0.01" }],
    },
    { USD: 1, CNY: 8, fallback: 1 },
  );
  assert.equal(result.isLow, true);
  assert.equal(result.fingerprint, "low:EUR");
});

test("evaluateBalance: is_available false outranks a healthy balance", () => {
  const result = evaluateBalance(
    {
      is_available: false,
      balance_infos: [{ currency: "USD", total_balance: "99" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.isLow, true);
  assert.equal(result.reason, "unavailable");
  assert.equal(result.fingerprint, "unavailable");
});

test("evaluateBalance: empty balance_infos is a malformed read, not a zero balance", () => {
  const result = evaluateBalance(
    { is_available: true, balance_infos: [] },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(result.ok, false);
  assert.equal(result.isLow, false);
  assert.equal(result.reason, "malformed");
});

// ---------------------------------------------------------------------------
// decideAlert — the seven transitions
// ---------------------------------------------------------------------------

const LOW = evaluateBalance(
  {
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "0.42" }],
  },
  { USD: 1, CNY: 8, fallback: null },
);
const OK = evaluateBalance(
  {
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "2.99" }],
  },
  { USD: 1, CNY: 8, fallback: null },
);

test("decideAlert 1: first ever low -> alert", () => {
  const out = decideAlert(initialState(), LOW, 1000, POLICY);
  assert.equal(out.shouldAlert, true);
  assert.equal(out.kind, "low");
  assert.equal(out.nextState.status, "LOW");
  assert.equal(out.nextState.alertCount, 1);
  assert.equal(out.nextState.lastThreshold, 1);
});

test("decideAlert 2: still low, same reason, inside the quiet window -> silent", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  const out = decideAlert(previous, LOW, HOUR, POLICY);
  assert.equal(out.shouldAlert, false);
  assert.equal(out.reason, "alreadyAlerted");
  assert.equal(out.nextState.alertCount, 1);
});

test("decideAlert 3: still low past the re-alert window -> reminder", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  const out = decideAlert(previous, LOW, 25 * HOUR, POLICY);
  assert.equal(out.shouldAlert, true);
  assert.equal(out.reason, "reAlert");
  assert.equal(out.nextState.alertCount, 2);
});

test("decideAlert 4: a different fingerprint re-arms immediately", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  const bothLow = evaluateBalance(
    {
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "0.10" },
        { currency: "CNY", total_balance: "1.00" },
      ],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  const out = decideAlert(previous, bothLow, HOUR, POLICY);
  assert.equal(out.shouldAlert, true);
  assert.equal(out.reason, "newCondition");
});

test("decideAlert 5: recovery past the hysteresis margin -> recovered alert", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  // 2.99 > 1 * 1.2
  const out = decideAlert(previous, OK, HOUR, POLICY);
  assert.equal(out.shouldAlert, true);
  assert.equal(out.kind, "recovered");
  assert.equal(out.nextState.status, "OK");
});

test("decideAlert 6: inside the hysteresis band -> stays LOW, silent", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  // 1.10 clears the threshold but not 1 * 1.2 — the flapping guard.
  const barely = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "1.10" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  const out = decideAlert(previous, barely, HOUR, POLICY);
  assert.equal(out.shouldAlert, false);
  assert.equal(out.reason, "withinHysteresis");
  assert.equal(out.nextState.status, "LOW");
});

test("decideAlert 6b: notifyRecovery off -> state clears without an alert", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  const out = decideAlert(previous, OK, HOUR, {
    ...POLICY,
    notifyRecovery: false,
  });
  assert.equal(out.shouldAlert, false);
  assert.equal(out.nextState.status, "OK");
});

test("decideAlert 7: errors stay silent until errorAlertAfter", () => {
  const failed = failedEvaluation("HTTP 401");
  const state = initialState();

  const first = decideAlert(state, failed, 1000, POLICY);
  assert.equal(first.shouldAlert, false);
  assert.equal(first.nextState.consecutiveErrors, 1);

  const second = decideAlert(first.nextState, failed, 2000, POLICY);
  assert.equal(second.shouldAlert, false);
  assert.equal(second.nextState.consecutiveErrors, 2);

  const third = decideAlert(second.nextState, failed, 3000, POLICY);
  assert.equal(third.shouldAlert, true);
  assert.equal(third.kind, "checkFailed");
  assert.equal(third.nextState.consecutiveErrors, 3);
});

test("decideAlert: a good read resets the error counter", () => {
  const out = decideAlert(
    { ...initialState(), consecutiveErrors: 2 },
    OK,
    1000,
    POLICY,
  );
  assert.equal(out.nextState.consecutiveErrors, 0);
  assert.equal(out.nextState.status, "OK");
});

test("decideAlert: ok -> ok stays silent", () => {
  const out = decideAlert(
    { ...initialState(), status: "OK" },
    OK,
    1000,
    POLICY,
  );
  assert.equal(out.shouldAlert, false);
  assert.equal(out.reason, "stillOk");
});

// ---------------------------------------------------------------------------
// describeAlert
// ---------------------------------------------------------------------------

test("describeAlert: low carries balance, threshold and CRITICAL severity", () => {
  const alert = describeAlert("low", LOW);
  assert.equal(alert.type, "deepseek.lowBalance");
  assert.equal(alert.severity, "CRITICAL");
  assert.match(alert.body, /0\.42 USD/);
  assert.match(alert.body, /1\.00 USD/);
  assert.equal(alert.data.currency, "USD");
  assert.equal(alert.data.threshold, 1);
});

test("describeAlert: unavailable is its own CRITICAL type", () => {
  const evaluation = evaluateBalance(
    {
      is_available: false,
      balance_infos: [{ currency: "USD", total_balance: "99" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  const alert = describeAlert("unavailable", evaluation);
  assert.equal(alert.type, "deepseek.unavailable");
  assert.equal(alert.severity, "CRITICAL");
});

test("describeAlert: recovered is INFO", () => {
  const alert = describeAlert("recovered", OK);
  assert.equal(alert.type, "deepseek.balanceRecovered");
  assert.equal(alert.severity, "INFO");
});

// ---------------------------------------------------------------------------
// fetchBalance (stubbed http client — no network)
// ---------------------------------------------------------------------------

test("fetchBalance: missing key fails without a request", async () => {
  let called = false;
  const result = await fetchBalance({
    apiKey: "",
    url: "https://api.deepseek.com/user/balance",
    httpClient: {
      get: async () => {
        called = true;
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_api_key");
  assert.equal(called, false);
});

test("fetchBalance: sends the Bearer key and returns the payload", async () => {
  let seenHeaders = null;
  const result = await fetchBalance({
    apiKey: "sk-test",
    url: "https://api.deepseek.com/user/balance",
    httpClient: {
      get: async (_url, config) => {
        seenHeaders = config.headers;
        return { data: DOC_SAMPLE };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, DOC_SAMPLE);
  assert.equal(seenHeaders.Authorization, "Bearer sk-test");
});

test("fetchBalance: an HTTP error is returned, not thrown, and hides the key", async () => {
  const result = await fetchBalance({
    apiKey: "sk-secret",
    url: "https://api.deepseek.com/user/balance",
    httpClient: {
      get: async () => {
        const err = new Error("Request failed");
        err.response = { status: 401 };
        throw err;
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 401");
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
});

// ---------------------------------------------------------------------------
// env readers
// ---------------------------------------------------------------------------

test("readThresholds: unset currency is null, not 0", () => {
  const thresholds = readThresholds({ DEEPSEEK_LOW_BALANCE_USD: "1" });
  assert.equal(thresholds.USD, 1);
  assert.equal(thresholds.CNY, null);
  assert.equal(thresholds.fallback, null);
});

test("readPolicy: defaults match the documented behaviour", () => {
  const policy = readPolicy({});
  assert.equal(policy.enabled, true);
  assert.equal(policy.checkIntervalMs, 60 * 60000);
  assert.equal(policy.reAlertMs, 24 * HOUR);
  assert.equal(policy.hysteresis, 0.2);
  assert.equal(policy.errorAlertAfter, 3);
});

test("readPolicy: DEEPSEEK_BALANCE_ENABLED=false turns the feature off", () => {
  assert.equal(
    readPolicy({ DEEPSEEK_BALANCE_ENABLED: "false" }).enabled,
    false,
  );
});

test("evaluateBalance: every balance carries the currently configured threshold", () => {
  // Not just the breaching ones — decideAlert's recovery check reads it.
  const healthy = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "2.99" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  assert.equal(healthy.isLow, false);
  assert.equal(healthy.primary.threshold, 1);
});

test("decideAlert: lowering the threshold must not wedge the monitor in LOW", () => {
  // Regression: hysteresis used to be measured against the threshold recorded
  // when the alert fired. If the admin then LOWERED DEEPSEEK_LOW_BALANCE_*, the
  // balance could never clear the old, higher bar and the state stayed LOW
  // forever — no recovery, and no further alerts once the quiet window applied.
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 99999, // the old, absurd threshold
    alertCount: 1,
    consecutiveErrors: 0,
  };
  const nowHealthy = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "2.99" }],
    },
    { USD: 1, CNY: 8, fallback: null }, // threshold has since been lowered to 1
  );
  const out = decideAlert(previous, nowHealthy, HOUR, POLICY);
  assert.equal(out.shouldAlert, true);
  assert.equal(out.kind, "recovered");
  assert.equal(out.nextState.status, "OK");
});

test("decideAlert: hysteresis still applies against the live threshold", () => {
  const previous = {
    status: "LOW",
    lastAlertAt: 0,
    lastFingerprint: "low:USD",
    lastThreshold: 1,
    alertCount: 1,
    consecutiveErrors: 0,
  };
  // 1.10 clears the live threshold of 1 but not 1 * 1.2.
  const barely = evaluateBalance(
    {
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "1.10" }],
    },
    { USD: 1, CNY: 8, fallback: null },
  );
  const out = decideAlert(previous, barely, HOUR, POLICY);
  assert.equal(out.shouldAlert, false);
  assert.equal(out.reason, "withinHysteresis");
});
