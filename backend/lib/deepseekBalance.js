/**
 * DeepSeek balance evaluation — pure decision logic, no Firestore, no Express.
 *
 * Everything here except `fetchBalance` is a pure function so it can be
 * unit-tested directly (see backend/tests/deepseekBalance.test.js). The
 * orchestration — throttling, state persistence, notifications, push — lives in
 * lib/balanceMonitor.js.
 *
 * The provider endpoint is `GET {AI_BASE_URL}/user/balance` with the same Bearer
 * key the grader uses, and answers:
 *
 *   { "is_available": true,
 *     "balance_infos": [ { "currency": "USD"|"CNY",
 *                          "total_balance": "2.99",
 *                          "granted_balance": "0.00",
 *                          "topped_up_balance": "2.99" } ] }
 *
 * Thresholds are configured PER CURRENCY (DEEPSEEK_LOW_BALANCE_USD /
 * DEEPSEEK_LOW_BALANCE_CNY) and compared directly against whatever currency the
 * API returns — deliberately no FX conversion, since a stale hard-coded rate
 * would silently shift the alert point.
 */

const axios = require("axios");

/** Currencies the provider documents. Others are tolerated but not judged. */
const KNOWN_CURRENCIES = ["USD", "CNY"];

const DEFAULT_BALANCE_PATH = "/user/balance";

/**
 * Balance endpoint derived from the chat base URL.
 *
 * `/user/balance` is NOT under `/v1`, unlike `/chat/completions`, so a base URL
 * ending in `/v1` must have it stripped. An explicit DEEPSEEK_BALANCE_URL always
 * wins — that is the escape hatch for a proxied or self-hosted provider.
 */
function balanceUrl(baseUrl, explicitUrl) {
  if (explicitUrl) return String(explicitUrl).trim();
  const base = String(baseUrl || "https://api.deepseek.com")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/, "");
  return `${base}${DEFAULT_BALANCE_PATH}`;
}

/** Finite number from an env string, else null (= "not configured"). */
function numericEnv(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function booleanEnv(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  return ["true", "1", "on", "enabled", "yes"].includes(
    String(raw).trim().toLowerCase(),
  );
}

/**
 * Per-currency alert thresholds. `fallback` applies to a currency with no
 * explicit threshold; when it too is null, that currency is never judged (see
 * evaluateBalance) — a false "top up now!" is worse than a missed alert.
 */
function readThresholds(env = process.env) {
  return {
    USD: numericEnv(env.DEEPSEEK_LOW_BALANCE_USD),
    CNY: numericEnv(env.DEEPSEEK_LOW_BALANCE_CNY),
    fallback: numericEnv(env.DEEPSEEK_LOW_BALANCE_FALLBACK),
  };
}

/** Timing / behaviour knobs, all env-tunable without a code change. */
function readPolicy(env = process.env) {
  return {
    enabled: booleanEnv(env.DEEPSEEK_BALANCE_ENABLED, true),
    checkIntervalMs:
      (numericEnv(env.DEEPSEEK_BALANCE_CHECK_INTERVAL_MINUTES) ?? 60) * 60000,
    reAlertMs:
      (numericEnv(env.DEEPSEEK_LOW_BALANCE_REALERT_HOURS) ?? 24) * 3600000,
    hysteresis: numericEnv(env.DEEPSEEK_LOW_BALANCE_HYSTERESIS) ?? 0.2,
    notifyRecovery: booleanEnv(env.DEEPSEEK_BALANCE_NOTIFY_RECOVERY, true),
    timeoutMs: numericEnv(env.DEEPSEEK_BALANCE_TIMEOUT_MS) ?? 8000,
    errorAlertAfter: numericEnv(env.DEEPSEEK_BALANCE_ERROR_ALERT_AFTER) ?? 3,
  };
}

/**
 * Normalises the provider payload.
 *
 * `total_balance` and friends arrive as STRINGS; entries that do not coerce to a
 * finite number are dropped and flagged via `malformed` rather than silently
 * read as 0 — a 0 would look like an empty account and fire a false alarm.
 *
 * Balances are sorted by currency so every downstream value (primary,
 * fingerprint, lastBalances) is deterministic regardless of array order.
 */
function parseBalanceResponse(payload) {
  const infos = Array.isArray(payload?.balance_infos)
    ? payload.balance_infos
    : [];
  const balances = [];
  let malformed = false;

  for (const info of infos) {
    const currency = String(info?.currency || "")
      .trim()
      .toUpperCase();
    const totalBalance = Number(info?.total_balance);
    if (!currency || !Number.isFinite(totalBalance)) {
      malformed = true;
      continue;
    }
    balances.push({
      currency,
      totalBalance,
      grantedBalance: Number(info?.granted_balance) || 0,
      toppedUpBalance: Number(info?.topped_up_balance) || 0,
    });
  }

  balances.sort((a, b) => a.currency.localeCompare(b.currency));
  return { isAvailable: payload?.is_available !== false, balances, malformed };
}

/**
 * Decides whether the current balance counts as low.
 *
 * `fingerprint` identifies the SITUATION, not the numbers — it is what
 * decideAlert compares to know whether anything actually changed. It is built
 * from the SORTED list of breaching currencies, so an account holding both USD
 * and CNY produces the same fingerprint no matter what order the provider
 * happens to return the array in; otherwise a reordered response would look like
 * a new condition and re-fire an alert that was already sent.
 */
function evaluateBalance(payload, thresholds) {
  const { isAvailable, balances, malformed } = parseBalanceResponse(payload);

  if (balances.length === 0) {
    return {
      ok: false,
      isAvailable,
      isLow: false,
      reason: "malformed",
      breaches: [],
      skipped: [],
      balances: [],
      primary: null,
      malformed: true,
      fingerprint: "malformed",
    };
  }

  const breaches = [];
  const skipped = [];
  // Every balance carries the CURRENTLY configured threshold, not only the
  // breaching ones. decideAlert's recovery check needs the live value: if it
  // used the threshold stored back when the alert fired, lowering
  // DEEPSEEK_LOW_BALANCE_* in the env would leave the monitor stuck in LOW
  // forever, because the balance could never clear the old, higher bar.
  const annotated = [];
  for (const balance of balances) {
    const threshold =
      thresholds?.[balance.currency] ?? thresholds?.fallback ?? null;
    if (threshold === null || threshold === undefined) {
      skipped.push(balance.currency);
      annotated.push({ ...balance, threshold: null });
      continue;
    }
    annotated.push({ ...balance, threshold });
    if (balance.totalBalance < threshold) {
      breaches.push({ ...balance, threshold });
    }
  }

  // The account being unusable outranks any threshold: the provider is telling
  // us it will refuse requests, which is the most urgent state there is.
  if (!isAvailable) {
    return {
      ok: true,
      isAvailable: false,
      isLow: true,
      reason: "unavailable",
      breaches,
      skipped,
      balances: annotated,
      primary: breaches[0] || annotated[0],
      malformed,
      fingerprint: "unavailable",
    };
  }

  const isLow = breaches.length > 0;
  return {
    ok: true,
    isAvailable: true,
    isLow,
    reason: isLow ? "low" : "ok",
    breaches,
    skipped,
    balances: annotated,
    primary: breaches[0] || annotated[0],
    malformed,
    fingerprint: isLow
      ? `low:${breaches
          .map((b) => b.currency)
          .sort()
          .join("+")}`
      : "ok",
  };
}

/** An evaluation standing in for a failed fetch, so decideAlert has one shape. */
function failedEvaluation(error) {
  return {
    ok: false,
    isAvailable: null,
    isLow: false,
    reason: "fetchFailed",
    breaches: [],
    skipped: [],
    balances: [],
    primary: null,
    error: error || "request_failed",
    fingerprint: "fetchFailed",
  };
}

/** Blank state for the very first run (or a wiped state doc). */
function initialState() {
  return {
    status: "UNKNOWN",
    lastAlertAt: null,
    lastFingerprint: null,
    lastThreshold: null,
    alertCount: 0,
    consecutiveErrors: 0,
  };
}

/**
 * The alert state machine. `previousState` is plain JS (millis, not Timestamps)
 * so this stays pure and testable; balanceMonitor converts at the boundary.
 *
 * The anti-spam rule is the LOW -> LOW branch: while the balance stays low for
 * the same reason we stay quiet until `reAlertMs` (24h) has passed, so a drained
 * account produces one alert a day, not one per grading run.
 */
function decideAlert(previousState, evaluation, now, policy) {
  const previous = { ...initialState(), ...(previousState || {}) };
  const noAlert = (nextState, reason) => ({
    shouldAlert: false,
    kind: null,
    nextState,
    reason,
  });

  // --- the check itself failed (network, auth, malformed payload) ---
  if (!evaluation.ok) {
    const consecutiveErrors = previous.consecutiveErrors + 1;
    const nextState = { ...previous, consecutiveErrors };
    const reAlertElapsed =
      previous.lastAlertAt === null ||
      now - previous.lastAlertAt >= policy.reAlertMs;
    // Stay quiet through transient blips; only a sustained failure is worth
    // waking anyone for, and then at most once per re-alert window.
    if (consecutiveErrors < policy.errorAlertAfter || !reAlertElapsed) {
      return noAlert(nextState, "errorBelowThreshold");
    }
    return {
      shouldAlert: true,
      kind: "checkFailed",
      nextState: {
        ...nextState,
        lastAlertAt: now,
        alertCount: previous.alertCount + 1,
      },
      reason: "checkFailed",
    };
  }

  const base = { ...previous, consecutiveErrors: 0 };

  // --- balance is low (or the account is unusable) ---
  if (evaluation.isLow) {
    const threshold =
      evaluation.primary?.threshold ?? previous.lastThreshold ?? null;
    const sameSituation =
      previous.status === "LOW" &&
      previous.lastFingerprint === evaluation.fingerprint;
    const withinQuietWindow =
      previous.lastAlertAt !== null &&
      now - previous.lastAlertAt < policy.reAlertMs;

    if (sameSituation && withinQuietWindow) {
      return noAlert(
        {
          ...base,
          status: "LOW",
          lastFingerprint: evaluation.fingerprint,
          lastThreshold: threshold,
        },
        "alreadyAlerted",
      );
    }

    return {
      shouldAlert: true,
      kind: evaluation.reason === "unavailable" ? "unavailable" : "low",
      nextState: {
        ...base,
        status: "LOW",
        lastFingerprint: evaluation.fingerprint,
        lastThreshold: threshold,
        lastAlertAt: now,
        alertCount: previous.alertCount + 1,
      },
      // A different fingerprint means a genuinely new situation (a second
      // currency ran dry), so it re-arms immediately instead of waiting.
      reason: sameSituation ? "reAlert" : "newCondition",
    };
  }

  // --- balance is fine ---
  if (previous.status !== "LOW") {
    return noAlert(
      { ...base, status: "OK", lastFingerprint: "ok", lastThreshold: null },
      "stillOk",
    );
  }

  // Was low, now isn't. Require the balance to clear the threshold by the
  // hysteresis margin before declaring recovery, so a balance hovering exactly
  // at the line cannot flip-flop between LOW and OK on every check.
  const recovered = evaluation.primary;
  // Prefer the threshold in force RIGHT NOW; fall back to the one recorded when
  // the alert fired only if the currency is no longer configured.
  const threshold = recovered?.threshold ?? previous.lastThreshold ?? null;
  const clearsMargin =
    threshold === null || threshold === undefined || !recovered
      ? true
      : recovered.totalBalance > threshold * (1 + policy.hysteresis);

  if (!clearsMargin) {
    return noAlert({ ...base, status: "LOW" }, "withinHysteresis");
  }

  if (!policy.notifyRecovery) {
    return noAlert(
      { ...base, status: "OK", lastFingerprint: "ok", lastThreshold: null },
      "recoveredSilently",
    );
  }

  return {
    shouldAlert: true,
    kind: "recovered",
    nextState: {
      ...base,
      status: "OK",
      lastFingerprint: "ok",
      lastThreshold: null,
      lastAlertAt: now,
      alertCount: previous.alertCount + 1,
    },
    reason: "recovered",
  };
}

/** Formats a balance for display without dragging in a currency library. */
function formatAmount(value) {
  return Number(value).toFixed(2);
}

/**
 * Renders an alert into the shape lib/notifications.js stores.
 *
 * Both a structured `data` object AND pre-rendered Vietnamese `title`/`body` are
 * produced: the bell renders from i18n keys + `data` (so it follows the user's
 * language), while the FCM payload and the service worker — which have no
 * access to the i18n dictionary — use the stored strings.
 */
function describeAlert(kind, evaluation) {
  const primary = evaluation.primary || null;
  const data = {
    currency: primary?.currency ?? null,
    totalBalance: primary?.totalBalance ?? null,
    threshold: primary?.threshold ?? null,
    isAvailable: evaluation.isAvailable,
    breaches: (evaluation.breaches || []).map((b) => ({
      currency: b.currency,
      totalBalance: b.totalBalance,
      threshold: b.threshold,
    })),
  };

  switch (kind) {
    case "unavailable":
      return {
        type: "deepseek.unavailable",
        severity: "CRITICAL",
        title: "Tài khoản DeepSeek không còn khả dụng",
        body:
          "DeepSeek báo tài khoản không thể phục vụ request nữa" +
          (primary
            ? ` (số dư ${formatAmount(primary.totalBalance)} ${primary.currency})`
            : "") +
          ". Việc chấm bài sẽ lỗi cho tới khi nạp thêm tiền.",
        data,
      };
    case "recovered":
      return {
        type: "deepseek.balanceRecovered",
        severity: "INFO",
        title: "Số dư DeepSeek đã ổn định trở lại",
        body: primary
          ? `Số dư hiện tại ${formatAmount(primary.totalBalance)} ${primary.currency}.`
          : "Số dư đã vượt lại ngưỡng cảnh báo.",
        data,
      };
    case "checkFailed":
      return {
        type: "deepseek.balanceCheckFailed",
        severity: "WARN",
        title: "Không đọc được số dư DeepSeek",
        body:
          "Gọi API số dư DeepSeek lỗi nhiều lần liên tiếp. " +
          "Kiểm tra lại AI_API_KEY hoặc kết nối mạng của backend.",
        data: { ...data, error: evaluation.error || null },
      };
    case "low":
    default:
      return {
        type: "deepseek.lowBalance",
        severity: "CRITICAL",
        title: "Số dư DeepSeek sắp hết",
        body: primary
          ? `Còn ${formatAmount(primary.totalBalance)} ${primary.currency} ` +
            `(ngưỡng ${formatAmount(primary.threshold)} ${primary.currency}). ` +
            "Vui lòng nạp thêm tài khoản DeepSeek."
          : "Số dư DeepSeek đã xuống dưới ngưỡng cảnh báo.",
        data,
      };
  }
}

/** Audit action name for an alert kind (see SYSTEM_ACTIONS in auditActions). */
function auditActionFor(kind) {
  switch (kind) {
    case "unavailable":
      return "ai.balanceUnavailable";
    case "recovered":
      return "ai.balanceRecovered";
    case "checkFailed":
      return "ai.balanceCheckFailed";
    case "low":
    default:
      return "ai.lowBalanceAlert";
  }
}

/**
 * The only function here that touches the network. `httpClient` is injected so
 * tests can stub it; production passes the shared axios.
 *
 * Never throws — a failure is returned as { ok: false } so the caller's state
 * machine can count it, rather than as an exception the alert path must catch.
 */
async function fetchBalance({
  apiKey,
  url,
  timeoutMs = 8000,
  httpClient = axios,
}) {
  if (!apiKey) {
    return { ok: false, error: "missing_api_key", status: null, payload: null };
  }
  try {
    const response = await httpClient.get(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      timeout: timeoutMs,
      validateStatus: (status) => status === 200,
    });
    return { ok: true, error: null, status: 200, payload: response.data };
  } catch (err) {
    return {
      ok: false,
      // Keep only a coarse reason: the message must be safe to write into
      // Firestore and the audit log, and must never carry the API key.
      error: err.response?.status
        ? `HTTP ${err.response.status}`
        : err.code || err.message || "request_failed",
      status: err.response?.status ?? null,
      payload: null,
    };
  }
}

module.exports = {
  DEFAULT_BALANCE_PATH,
  KNOWN_CURRENCIES,
  auditActionFor,
  balanceUrl,
  decideAlert,
  describeAlert,
  evaluateBalance,
  failedEvaluation,
  fetchBalance,
  formatAmount,
  initialState,
  parseBalanceResponse,
  readPolicy,
  readThresholds,
};
