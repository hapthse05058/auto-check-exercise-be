/**
 * The SEC LMS REST API (https://lms-api.anhngusec.edu.vn), as its own teacher
 * screens use it. Nothing here ever SUBMITS a grading: the only write is
 * "Lưu nháp" (saveDraft). Submitting stays a teacher's click on the LMS.
 *
 * The LMS answers HTTP 200 for most errors and puts the real code in the body
 * ({statusCode: 403, message: "Forbidden"}), so both are checked.
 *
 * Retry rules (plan "Giai đoạn 2", lmsClient):
 *   401           the caller's token source logs in again, once
 *   429           wait Retry-After (capped), at most 3 times
 *   5xx / network GET: retried with backoff. PUT: never blindly retried —
 *                 it may have landed; LmsError("write_uncertain") makes the
 *                 job re-read the student's page and decide (plan R6)
 *   captcha / wrong password: stop, the teacher must re-link the account
 */

const DEFAULT_BASE_URL = "https://lms-api.anhngusec.edu.vn";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30000;

class LmsError extends Error {
  /**
   * @param code   captcha_required | bad_credentials | unauthorized |
   *               forbidden | not_found | rate_limited | lms_unavailable |
   *               write_uncertain | bad_response | lms_error
   */
  constructor(code, { status = null, message = null } = {}) {
    super(message ? `${code}: ${message}` : code);
    this.name = "LmsError";
    this.code = code;
    this.status = status;
  }
}

/** Expiry (ms) of a JWT, or null when it cannot be read. */
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"),
    );
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function codeOfStatus(status) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "lms_unavailable";
  return "lms_error";
}

const safeMessage = (body) =>
  typeof body?.message === "string" ? body.message.slice(0, 200) : null;

/**
 * @param deps.baseUrl
 * @param deps.fetchImpl   fetch-compatible (injectable for tests)
 * @param deps.sleep       (ms) => Promise (injectable for tests)
 * @param deps.timeoutMs
 */
function createLmsClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  /** One HTTP exchange → {status, body, retryAfterMs}; throws on network. */
  async function exchange(method, path, { token, body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      // The LMS reports most failures inside a 200.
      const status =
        response.status === 200 && Number.isFinite(parsed?.statusCode)
          ? parsed.statusCode
          : response.status;
      return {
        status,
        body: parsed,
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A call with the retry rules above. Returns the body's `data`.
   * `idempotent` is true for GETs; a PUT that may have landed is never
   * repeated here.
   */
  async function call(method, path, { token, body, idempotent }) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let result;
      try {
        result = await exchange(method, path, { token, body });
      } catch (err) {
        // Network error or our own timeout (AbortError).
        if (!idempotent) {
          throw new LmsError("write_uncertain", { message: err.name });
        }
        if (attempt >= MAX_ATTEMPTS) {
          throw new LmsError("lms_unavailable", { message: err.name });
        }
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      const { status } = result;
      if (status >= 200 && status < 300) {
        if (!result.body || typeof result.body !== "object") {
          throw new LmsError("bad_response", { status });
        }
        return result.body.data;
      }
      if (status === 429 && attempt < MAX_ATTEMPTS) {
        // Refused, so nothing landed: safe to repeat even a PUT.
        await sleep(
          Math.min(result.retryAfterMs ?? 2000 * attempt, MAX_RETRY_AFTER_MS),
        );
        continue;
      }
      if (status >= 500) {
        if (!idempotent) {
          throw new LmsError("write_uncertain", { status });
        }
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
      throw new LmsError(codeOfStatus(status), {
        status,
        message: safeMessage(result.body),
      });
    }
  }

  /**
   * Logs in with the LMS's own phone + password form. Never retried on a
   * refusal: repeated failures are what turns the LMS captcha on.
   * @returns {{token, expiresAt, user: {id, name}}}
   */
  async function login(username, password) {
    const phone = String(username || "").trim();
    if (!phone || !password) throw new LmsError("bad_credentials");
    const captcha = await call(
      "GET",
      `/api/auth/v1/captcha-required?username=${encodeURIComponent(phone)}`,
      { idempotent: true },
    );
    if (captcha === true) throw new LmsError("captcha_required");
    let data;
    try {
      data = await call("POST", "/api/auth/v1/login", {
        body: { username: phone, password, captchaToken: null },
        // A refused login did not land; a lost one is simply tried again later.
        idempotent: false,
      });
    } catch (err) {
      if (err instanceof LmsError && err.code === "write_uncertain") {
        throw new LmsError("lms_unavailable", { status: err.status });
      }
      if (err instanceof LmsError && err.code !== "lms_unavailable") {
        throw new LmsError("bad_credentials", { status: err.status });
      }
      throw err;
    }
    if (!data?.token) throw new LmsError("bad_response");
    return {
      token: data.token,
      expiresAt: jwtExpiryMs(data.token),
      user: {
        id: data.user?.id ?? null,
        name: data.user?.fullName || data.user?.name || "",
      },
    };
  }

  /**
   * The teacher API, authenticated through a token source:
   *   { get(): Promise<token>, refresh(): Promise<token> }
   * A 401 refreshes the token once and repeats the call.
   */
  function forTeacher(tokens) {
    async function authed(method, path, options) {
      let token = await tokens.get();
      try {
        return await call(method, path, { ...options, token });
      } catch (err) {
        if (!(err instanceof LmsError) || err.code !== "unauthorized") {
          throw err;
        }
        token = await tokens.refresh();
        return call(method, path, { ...options, token });
      }
    }
    const get = (path) => authed("GET", path, { idempotent: true });
    const id = (value) => encodeURIComponent(String(value));

    return {
      /** The teacher's classes: [{id, code, courseCode, courseName, ...}]. */
      async listClasses() {
        const data = await get("/api/class/v1/role?page=0&size=100");
        return Array.isArray(data?.content) ? data.content : [];
      },
      /** Sessions of a class: [{id, sessionName, startTime, deadlines}]. */
      async listSessions(classId) {
        const data = await get(`/api/assignment/v1/class/${id(classId)}`);
        return Array.isArray(data) ? data : [];
      },
      /** Students of a session with each assignment's gradingStatus. */
      async listSubmissions(classId, sessionId) {
        const data = await get(
          `/api/student-payment/v1/class/${id(classId)}/session/${id(sessionId)}` +
            "/assignment-score-report?page=0&size=200",
        );
        return Array.isArray(data?.content) ? data.content : [];
      },
      /** One student's session, as the LMS grading page loads it. */
      async getGrading(classId, sessionId, studentId) {
        const data = await get(
          `/api/score-report/v1/class/${id(classId)}/session/${id(sessionId)}` +
            `/grading/${id(studentId)}/assignment`,
        );
        if (!Array.isArray(data)) throw new LmsError("bad_response");
        return data;
      },
      /** "Lưu nháp" — the LMS UI's draft save. NOT the submit endpoint. */
      async saveDraft(classId, sessionId, studentId, payload) {
        return authed(
          "PUT",
          `/api/score-report/v1/class/${id(classId)}/session/${id(sessionId)}` +
            `/grading/${id(studentId)}/assignment`,
          { body: payload, idempotent: false },
        );
      },
    };
  }

  return { forTeacher, login };
}

/** The LMS page where a teacher reviews (and submits) one student's work. */
function lmsGradingPageUrl(classId, sessionId, studentId) {
  return (
    `https://lms.anhngusec.edu.vn/teacher/class/detail/${classId}` +
    `/session/${sessionId}/grading/${studentId}/assignment`
  );
}

module.exports = {
  DEFAULT_BASE_URL,
  LmsError,
  createLmsClient,
  jwtExpiryMs,
  lmsGradingPageUrl,
};
