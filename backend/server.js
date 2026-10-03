const fs = require("fs");
const path = require("path");
require("dotenv").config();
const crypto = require("crypto");

const axios = require("axios");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const { OAuth2Client, GoogleAuth } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");

// Firebase Admin + the Firestore handle (database chosen by FIRESTORE_DATABASE_ID).
// `serviceAccountPath` is reused below for the Google Docs auth client.
const auditActions = require("./lib/auditActions.js");
const auditLog = require("./lib/auditLog.js");
const balanceMonitor = require("./lib/balanceMonitor.js");
const billing = require("./lib/billing.js");
const {
  CourseError,
  createCourses,
  gradingProfileOf,
} = require("./lib/courses.js");
const { admin, db, serviceAccountPath } = require("./lib/firestore.js");
const { findDuplicateDocs } = require("./lib/googleDoc.js");
const googleDocsApi = require("./lib/googleDocsApi.js");
const {
  createGoogleUserTokens,
  createTokenCipher,
  describeError: describeGoogleError,
  parseKeys,
} = require("./lib/googleUserToken.js");
const {
  JobError,
  RetryLater,
  createGradingJobs,
} = require("./lib/gradingJobs.js");
const {
  createGradingSchedules,
  scheduleAwareOnFinished,
} = require("./lib/gradingSchedules.js");
const {
  TASK_ACTIVE_PASSIVE,
  TASK_PARAGRAPH,
  TASK_TYPES,
  cleanContent,
  gradingCacheKey,
  normalizeForKey,
  normalizeTaskType,
} = require("./lib/gradingKey.js");
const {
  gradeParagraphGroup,
  paragraphText,
} = require("./lib/paragraphFeedback.js");
const notifications = require("./lib/notifications.js");
const pushDevices = require("./lib/pushDevices.js");
const { createCloudQueue, createInlineQueue } = require("./lib/taskQueue.js");
const teacherFilter = require("./lib/teacherFilter.js");
const teacherPreferences = require("./lib/teacherPreferences.js");
const teacherPoints = require("./lib/teacherPoints.js");
const ieltsWriting = require("./lib/ieltsWriting.js");
const hsGrading = require("./lib/hsGrading.js");
const ieltsChartData = require("./lib/ieltsChartData.js");
const ieltsPaste = require("./lib/ieltsPaste.js");

const app = express();
const courses = createCourses({ db });
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXTENSION_SECRET_KEY = process.env.EXTENSION_SECRET_KEY;
const JWT_SECRET =
  process.env.JWT_SECRET || "your-secret-key-change-in-production";
// Bump this (or change AI_MODEL) to invalidate the gradingCache: cached
// feedback is keyed on promptVersion + model + question + answer.
const PROMPT_VERSION = process.env.PROMPT_VERSION || "v1";

app.use(cors());
// Body size limit. Register the parsers EXACTLY ONCE: body-parser sets
// req._body after the first parse, so an earlier app.use(express.json())
// without a limit would win and silently cap every request at its 100kb
// default, turning these two lines into a no-op. That is precisely what made
// buổi 16/17 fail with "Payload Too Large" - those lessons put "câu đơn" +
// "câu phức" in one cell, so a class of ~23 students already exceeded 100kb.
//
// cors() must stay ABOVE these: PayloadTooLargeError is raised inside the
// parser and jumps straight to the error handler, skipping every plain
// middleware that follows. Mounted below, cors() would be skipped on exactly
// the response that needs it, and the browser would report an opaque network
// error instead of the real 413.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

/**
 * Audit trail for every state-changing request (see lib/auditActions.js for the
 * route→action table and lib/auditLog.js for the writer).
 *
 * Mounted here on purpose: AFTER the body parsers, so req.body exists, and
 * BEFORE every route, so nothing can slip past it.
 *
 * The entry is assembled in res.on("finish") — that is the only point where the
 * status code is known AND req.userEmail has been set by verifyToken, which
 * runs per-route and therefore AFTER this middleware's body.
 */
function auditMiddleware(req, res, next) {
  if (!auditActions.shouldAudit(req.method, req.path)) return next();

  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const startedAt = Date.now();
  // Deep copy: handlers mutate req.body in place, and we log after they finish.
  const body = auditLog.snapshotBody(req.body);

  res.on("finish", () => {
    (async () => {
      const statusCode = res.statusCode;
      // Routes that answer 2xx but failed in business terms set this flag.
      const success =
        typeof res.locals.auditSuccess === "boolean"
          ? res.locals.auditSuccess
          : statusCode < 400;

      const descriptor = auditActions.matchAction(req.method, req.path);
      let action = descriptor.action;
      let severity = descriptor.severity;
      if (!success) {
        if (descriptor.failedAction) action = descriptor.failedAction;
        severity = descriptor.failedSeverity || severity;
        // A failure is never merely informational.
        if (severity === "INFO") severity = "WARN";
      }

      // Authenticated routes carry the actor on the token; the login/signup/
      // reset routes run before any verification, so fall back to the body.
      let actorEmail = req.userEmail || null;
      let actorResolvedFrom = "unknown";
      let actorName = null;
      let actorId = null;
      if (actorEmail) {
        actorResolvedFrom = "token";
        const actor = await auditLog.resolveActor(db, actorEmail);
        actorName = actor.name;
        actorId = actor.id;
      } else if (body && typeof body === "object") {
        actorEmail = body.username || body.email || body.gmail || null;
        if (actorEmail) actorResolvedFrom = "body";
      }

      auditLog.recordAudit(db, admin, {
        requestId,
        actorEmail,
        actorName,
        actorId,
        actorResolvedFrom,
        action,
        resourceType: descriptor.resourceType,
        severity,
        method: req.method,
        path: req.path,
        entityId: auditActions.entityIdFromPath(req.path),
        statusCode,
        success,
        durationMs: Date.now() - startedAt,
        // A route that knows a readable summary of itself sets
        // res.locals.auditDetail; everything else falls back to the body.
        detail: res.locals.auditDetail ?? auditLog.summarizeBody(body),
        ip: (req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip,
        userAgent: req.headers["user-agent"] || "",
      });
    })().catch((err) => console.error("[AUDIT] middleware failed:", err));
  });

  next();
}

app.use(auditMiddleware);

// Firebase Admin + Firestore (`admin`, `db`) are initialized in ./lib/firestore.js
// and imported at the top of this file.

/**
 * Google auth client backed by the service account key, used to mint REAL
 * Google OAuth access tokens for the Google Docs API.
 *
 * Username/password login only produces a self-signed JWT (valid for THIS
 * backend only). Google APIs reject that JWT with 401. Since student docs are
 * shared as "anyone with the link can edit", any valid Google identity can
 * read/write them — so we mint a token from the service account and hand it to
 * the client to use against docs.googleapis.com.
 */
const googleDocsAuth = fs.existsSync(serviceAccountPath)
  ? new GoogleAuth({
      keyFile: serviceAccountPath,
      scopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive",
      ],
    })
  : null;

async function getServiceAccountGoogleToken() {
  if (!googleDocsAuth) {
    throw new Error("Service account not configured; cannot mint Google token");
  }
  const client = await googleDocsAuth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error(
      "Failed to obtain Google access token from service account",
    );
  }
  return token;
}

if (!process.env.AI_API_KEY && !OPENAI_API_KEY) {
  console.warn(
    "WARNING: AI_API_KEY (DeepSeek) not set. Grading will fail until provided.",
  );
}

async function isClassNameDuplicated(newClassName, excludeId = null) {
  const snapshot = await db.collection("classes").get();
  const target = String(newClassName ?? "").toLowerCase();
  const classes = [];
  snapshot.forEach((doc) => {
    classes.push({
      id: doc.id,
      name: String(doc.data().name ?? "").toLowerCase(),
    });
  });
  const duplicateClassSnapshot = classes.filter(
    (cls) => cls.id !== excludeId && cls.name === target,
  );
  return duplicateClassSnapshot.length > 0;
}

async function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const secret_key = req.headers["x-api-key"];
  if (secret_key !== EXTENSION_SECRET_KEY) {
    return res.status(401).send("Invalid key");
  }
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send("Missing Token");
  }

  const token = authHeader.split(" ")[1];

  try {
    // First, try to verify as JWT (for username/password login)
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userEmail = decoded.email;
      // Username/password: no Google identity, so background jobs write docs
      // with the service account (see lib/googleUserToken.js).
      req.authKind = "jwt";
      return next();
    } catch {
      // If JWT fails, try Google token verification
    }

    // Try Google token verification (for Google OAuth)
    const response = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`,
    );
    const userInfo = await response.json();

    if (!userInfo.email) {
      return res.status(401).send("Invalid Token");
    }

    const userEmail = userInfo.email.toLowerCase();
    const teacherDoc = await db
      .collection("teachers")
      .where("gmail", "==", userEmail)
      .get();
    if (teacherDoc.empty) {
      return res
        .status(403)
        .json({ error: "Access denied. User is not a registered teacher." });
    }
    if (teacherDoc.docs[0].data().isAccountActive === false) {
      return res.status(403).json({ error: "account_closed" });
    }
    req.userEmail = userEmail;
    req.authKind = "google";
    next();
  } catch (error) {
    console.error("Error verifying token:", error);
    res.status(401).send("Unauthorized");
  }
}

// Keep old name as alias for backwards compatibility
const verifyGoogleToken = verifyToken;

app.post("/exchange-token", async (req, res) => {
  const { code, redirectUri, refreshToken, grantType } = req.body;

  const clientId =
    "159733287448-jtf963s4659vl9oh6480bh125dhc2d5p.apps.googleusercontent.com";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientSecret) {
    return res.status(500).json({
      error: "client_secret_not_configured",
      message: "GOOGLE_CLIENT_SECRET not set in .env",
    });
  }

  let tokenParams;

  if (grantType === "refresh_token" && refreshToken) {
    // Handle refresh token request
    tokenParams = {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    };
  } else if (code && redirectUri) {
    // Handle authorization code exchange
    tokenParams = {
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    };
  } else {
    return res.status(400).json({ error: "invalid_request_parameters" });
  }

  try {
    const tokenResponse = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams(tokenParams).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    return res.json(tokenResponse.data);
  } catch (err) {
    console.error("Token exchange error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "token_exchange_failed",
      details: err.response?.data || err.message,
    });
  }
});

// AI grader provider. DeepSeek is OpenAI-API-compatible for /chat/completions,
// so we keep the OpenAI SDK and just repoint baseURL + key + model.
// In .env set:
//   AI_BASE_URL=https://api.deepseek.com
//   AI_API_KEY=<your DeepSeek API key>
//   AI_MODEL=deepseek-chat
// Model ids: `deepseek-v4-pro` / `deepseek-v4-flash` (or legacy aliases
// `deepseek-chat` = flash non-thinking, `deepseek-reasoner` = flash thinking).
// Thinking mode is toggled via AI_THINKING (enabled/disabled). When enabled,
// DeepSeek ignores temperature/top_p, so we omit them and pass reasoning_effort.
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.deepseek.com";
const AI_API_KEY = process.env.AI_API_KEY || OPENAI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
const AI_THINKING_ENABLED = ["enabled", "true", "1", "on"].includes(
  (process.env.AI_THINKING || "disabled").toLowerCase(),
);
const AI_REASONING_EFFORT = process.env.AI_REASONING_EFFORT || "high"; // high | max
const openai = new OpenAI({
  apiKey: AI_API_KEY,
  baseURL: AI_BASE_URL,
});

/**
 * Calls the AI grader via chat completions (DeepSeek / any OpenAI-compatible
 * provider) and returns the cleaned response text. The grading instruction is
 * the system message; the dataset is the user message.
 */
async function callGrader(instruction, inputText, model) {
  const params = {
    model: model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: inputText },
    ],
  };
  if (AI_THINKING_ENABLED) {
    // Thinking mode: DeepSeek emits chain-of-thought in `reasoning_content`
    // (ignored — we only read the final `content`). temperature/top_p are not
    // supported in this mode, so omit them and pass reasoning_effort instead.
    params.reasoning_effort = AI_REASONING_EFFORT;
    params.thinking = { type: "enabled" };
  } else {
    params.temperature = 0.5;
    params.top_p = 0.14;
  }
  const response = await openai.chat.completions.create(params);
  return (response.choices?.[0]?.message?.content || "")
    .replace(/【.*?】|<br>|/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// IELTS Writing (lib/ieltsWriting.js) — a separate model, prompt and version.
// Nothing here touches the Basic grader above.
// The GRADER (OpenAI-compatible chat completions):
//   IELTS_AI_BASE_URL, IELTS_AI_API_KEY, IELTS_AI_MODEL
//   IELTS_AI_JSON_MODE=true   send response_format json_object (if supported)
//   IELTS_AI_THINKING=enabled|disabled   DeepSeek only (`thinking` param);
//                             unset = the model's default. Other providers: unset.
//   IELTS_PROMPT_VERSION      bump to invalidate ieltsGradingCache
// The CHART READER (lib/ieltsChartData.js): a strong vision model that reads
// each Task 1 chart once into text, cached in ieltsChartData; the grader then
// grades from that text and never sees the image. Unset → the grader gets the
// images itself (and must then be a vision model).
//   IELTS_CHART_AI_BASE_URL, IELTS_CHART_AI_API_KEY, IELTS_CHART_AI_MODEL
//   IELTS_CHART_PROMPT_VERSION   bump to re-read every chart
// ---------------------------------------------------------------------------
const IELTS_AI_BASE_URL = process.env.IELTS_AI_BASE_URL || "";
const IELTS_AI_API_KEY = process.env.IELTS_AI_API_KEY || "";
const IELTS_AI_MODEL = process.env.IELTS_AI_MODEL || "";
const IELTS_AI_JSON_MODE = ["true", "1", "on"].includes(
  String(process.env.IELTS_AI_JSON_MODE || "").toLowerCase(),
);
const IELTS_AI_THINKING = String(process.env.IELTS_AI_THINKING || "")
  .trim()
  .toLowerCase();
const IELTS_PROMPT_VERSION = process.env.IELTS_PROMPT_VERSION || "v1";
const ieltsConfigured = Boolean(IELTS_AI_API_KEY && IELTS_AI_MODEL);
if (!ieltsConfigured) {
  console.warn(
    "WARNING: IELTS_AI_API_KEY / IELTS_AI_MODEL not set. IELTS grading is off.",
  );
}
const ieltsClient = ieltsConfigured
  ? new OpenAI({
      apiKey: IELTS_AI_API_KEY,
      ...(IELTS_AI_BASE_URL ? { baseURL: IELTS_AI_BASE_URL } : {}),
    })
  : null;

async function callIeltsModel(instruction, content, model) {
  const params = {
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content },
    ],
    temperature: 0.3,
    // deepseek-flash writes up to ~15k tokens (mostly reasoning) on a long
    // essay; at 16000 some answers were cut off before the JSON.
    max_tokens: 24000,
  };
  if (IELTS_AI_JSON_MODE) params.response_format = { type: "json_object" };
  if (IELTS_AI_THINKING) params.thinking = { type: IELTS_AI_THINKING };
  let response = await ieltsClient.chat.completions.create(params);
  // A thinking model can reason past any limit and answer nothing (seen on a
  // sentence-rewrite exercise, twice at 32k): ask once more with low effort,
  // which answered it in ~15k. DeepSeek's `reasoning_effort`: low|high|max.
  if (
    response.choices?.[0]?.finish_reason === "length" &&
    IELTS_AI_THINKING !== "disabled"
  ) {
    response = await ieltsClient.chat.completions.create({
      ...params,
      reasoning_effort: "low",
    });
  }
  return (response.choices?.[0]?.message?.content || "").trim();
}

const IELTS_CHART_AI_BASE_URL = process.env.IELTS_CHART_AI_BASE_URL || "";
const IELTS_CHART_AI_API_KEY = process.env.IELTS_CHART_AI_API_KEY || "";
const IELTS_CHART_AI_MODEL = process.env.IELTS_CHART_AI_MODEL || "";
const IELTS_CHART_PROMPT_VERSION =
  process.env.IELTS_CHART_PROMPT_VERSION || "v1";
const ieltsChartClient =
  IELTS_CHART_AI_API_KEY && IELTS_CHART_AI_MODEL
    ? new OpenAI({
        apiKey: IELTS_CHART_AI_API_KEY,
        ...(IELTS_CHART_AI_BASE_URL
          ? { baseURL: IELTS_CHART_AI_BASE_URL }
          : {}),
      })
    : null;
if (ieltsConfigured && !ieltsChartClient) {
  console.warn(
    "WARNING: IELTS_CHART_AI_* not set. Task 1 charts go to IELTS_AI_MODEL as images.",
  );
}

async function callIeltsChartModel(instruction, content, model) {
  const response = await ieltsChartClient.chat.completions.create({
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content },
    ],
    temperature: 0,
    max_tokens: 8000,
  });
  return (response.choices?.[0]?.message?.content || "").trim();
}

const ieltsChartReader = ieltsChartClient
  ? ieltsChartData.createChartReader({
      db,
      callModel: callIeltsChartModel,
      readPrompt: () =>
        fs.readFileSync(path.join(__dirname, "prompt_ielts_chart.txt"), "utf8"),
      model: IELTS_CHART_AI_MODEL,
      version: IELTS_CHART_PROMPT_VERSION,
    })
  : null;

const ieltsGrader = ieltsWriting.createIeltsGrader({
  db,
  callModel: callIeltsModel,
  readPrompt: () =>
    fs.readFileSync(path.join(__dirname, "prompt_ielts_writing.txt"), "utf8"),
  model: IELTS_AI_MODEL,
  promptVersion: IELTS_PROMPT_VERSION,
  readChart: ieltsChartReader ? ieltsChartReader.read : null,
});
// ---------------------------------------------------------------------------
// HS course (lib/hsGrading.js) — its own prompt (prompt_hs.txt), version,
// cache (hsGradingCache) and answer key (lib/hs/hsAnswerKey.json). Nothing
// here touches the Basic or IELTS graders above.
//   HS_AI_BASE_URL, HS_AI_API_KEY, HS_AI_MODEL   default: the Basic AI_* ones
//   HS_AI_JSON_MODE=true      send response_format json_object (if supported)
//   HS_AI_THINKING=enabled|disabled   DeepSeek only; unset = model default
//   HS_PROMPT_VERSION         bump to invalidate hsGradingCache
// ---------------------------------------------------------------------------
const HS_AI_BASE_URL = process.env.HS_AI_BASE_URL || AI_BASE_URL;
const HS_AI_API_KEY = process.env.HS_AI_API_KEY || AI_API_KEY || "";
const HS_AI_MODEL = process.env.HS_AI_MODEL || AI_MODEL;
const HS_AI_JSON_MODE = ["true", "1", "on"].includes(
  String(process.env.HS_AI_JSON_MODE || "").toLowerCase(),
);
const HS_AI_THINKING = String(process.env.HS_AI_THINKING || "")
  .trim()
  .toLowerCase();
// v2 (2026-10-01): teachers' feedback — "V nguyên thể", no NTNS before Buổi 14,
// Vietnamese meaning for the rearrange exercises.
const HS_PROMPT_VERSION = process.env.HS_PROMPT_VERSION || "v2";
const hsConfigured = Boolean(HS_AI_API_KEY && HS_AI_MODEL);
if (!hsConfigured) {
  console.warn("WARNING: HS_AI_* / AI_* not set. HS grading is off.");
}
const hsClient = hsConfigured
  ? new OpenAI({
      apiKey: HS_AI_API_KEY,
      ...(HS_AI_BASE_URL ? { baseURL: HS_AI_BASE_URL } : {}),
    })
  : null;

async function callHsModel(instruction, content, model) {
  const params = {
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content },
    ],
    temperature: 0.2,
    max_tokens: 16000,
  };
  if (HS_AI_JSON_MODE) params.response_format = { type: "json_object" };
  if (HS_AI_THINKING) params.thinking = { type: HS_AI_THINKING };
  let response = await hsClient.chat.completions.create(params);
  // Same rescue as IELTS: a thinking model that reasoned past the limit is
  // asked once more with low effort.
  if (
    response.choices?.[0]?.finish_reason === "length" &&
    HS_AI_THINKING !== "disabled"
  ) {
    response = await hsClient.chat.completions.create({
      ...params,
      reasoning_effort: "low",
    });
  }
  return (response.choices?.[0]?.message?.content || "").trim();
}

/** The reviewed answer key (scripts/buildHsAnswerKey.js); empty until built. */
function loadHsAnswerKey() {
  const file = path.join(__dirname, "lib", "hs", "hsAnswerKey.json");
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const hsGrader = hsGrading.createHsGrader({
  db,
  callModel: callHsModel,
  readPrompt: () =>
    fs.readFileSync(path.join(__dirname, "prompt_hs.txt"), "utf8"),
  model: HS_AI_MODEL,
  promptVersion: HS_PROMPT_VERSION,
  answerKey: loadHsAnswerKey(),
});

// Used by the retired Chrome extension. Kept only while installed copies may
// still call it; the website grades through /grading-jobs.
app.post("/grade", verifyGoogleToken, async (req, res) => {
  const items = req.body.items;
  const model = AI_MODEL;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "no_items_provided" });
  }

  const studentExercises = items
    .map(
      (item) =>
        `\n[VIETNAMESE]: ${item.question}\n[STUDENT_ANSWER]: ${item.answer}`,
    )
    .join("\n");

  try {
    const inputText = `DATASET TO EVALUATE:\`\`\`\n${studentExercises}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;
    const instructionFilePath = path.join(
      __dirname,
      "prompt_and_instruction_for_responses_api.txt",
    );
    if (!fs.existsSync(instructionFilePath)) {
      throw new Error(`Instruction file not found: ${instructionFilePath}`);
    }
    const prompt_and_instruction_for_ai = fs.readFileSync(
      instructionFilePath,
      "utf8",
    );
    const aiResponse = await callGrader(
      prompt_and_instruction_for_ai.trim(),
      inputText,
      model,
    );

    // Same opportunistic balance check as /grade-cached (throttled inside).
    balanceMonitor
      .maybeCheckAndAlert({
        db,
        admin,
        adminEmails: ADMIN_EMAILS,
        requestId: req.requestId,
      })
      .catch((err) => console.error("[BALANCE] check failed:", err.message));

    if (!aiResponse) {
      throw new Error("Assistant returned no output.");
    }

    return res.json({
      success: true,
      assistantText: aiResponse,
    });
  } catch (err) {
    console.error("[GRADE] Detailed OpenAI Error:", JSON.stringify(err));
    return res.status(500).json({
      error: "openai_request_failed",
      details: err.message || "Unknown Error",
    });
  }
});

// ---------------------------------------------------------------------------
// Cached grading (/grade-cached)
//
// The website FE sends a DEDUPED array of unique {question, answer} pairs for a
// whole class. We reuse feedback from the gradingCache collection when present,
// only send genuine cache misses to OpenAI, persist the new feedback, and
// return feedback per pair. The FE re-maps feedback to each student by the same
// (question, answer) pair and writes it into the right doc row by question index.
// ---------------------------------------------------------------------------

// `normalizeForKey` và `gradingCacheKey` sống ở ./lib/gradingKey.js — tách ra
// để test được mà không phải khởi động Express + firebase-admin, vì tính chất
// quan trọng nhất ở đó (khoá của bài dịch KHÔNG đổi) chỉ chứng minh được bằng
// test.

/** gradingCache id for the current PROMPT_VERSION (used by the grading flow). */
function gradingCacheId(question, answer, model, taskType) {
  return gradingCacheKey(PROMPT_VERSION, model, question, answer, taskType);
}

// Always admins, whatever ADMIN_EMAILS says (the website's config.js lists
// them too, to show the admin screens).
const BUILT_IN_ADMINS = ["phamvanvy0306@gmail.com"];

// Admin allow-list for the gradingCache management endpoints (comma-separated).
const ADMIN_EMAILS = [
  ...new Set([
    ...BUILT_IN_ADMINS,
    ...(process.env.ADMIN_EMAILS || "phamhongha.innerpiece@gmail.com")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ]),
];

/** Gate: must run AFTER verifyToken (which sets req.userEmail). */
function requireAdmin(req, res, next) {
  if (!ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase())) {
    return res.status(403).json({ error: "admin_only" });
  }
  next();
}

// Text fields searchable from the gradingCache management screen.
const GRADING_CACHE_FIELDS = [
  "question",
  "answer",
  "feedback",
  "model",
  "promptVersion",
  "taskType",
];

/** Runs async task factories with a bounded concurrency. */
async function runWithConcurrency(taskFactories, limit) {
  const results = new Array(taskFactories.length);
  let cursor = 0;
  async function worker() {
    while (cursor < taskFactories.length) {
      const index = cursor++;
      results[index] = await taskFactories[index]();
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, taskFactories.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

/** Parses the AI markdown table into a { STT -> "Chữa bài" } map. */
function parseGradedTable(aiText) {
  const map = {};
  for (const line of aiText.split("\n")) {
    if (!line.includes("|") || line.includes("---")) continue;
    const cleanLine = line.trim().replace(/^\||\|$/g, "");
    const columns = cleanLine.split("|").map((col) => col.trim());
    // Real rows have >=4 columns and a numeric STT in column 0.
    if (columns.length >= 4 && /^\d+$/.test(columns[0])) {
      map[columns[0]] = columns[3];
    }
  }
  return map;
}

/**
 * Grades ONE group of uncached items with OpenAI. Each item is renumbered
 * 1..k (unique within the group) so the returned table maps back
 * unambiguously. Returns feedback aligned to `group` by index (null if the AI
 * did not return a row for that item).
 */
async function gradeGroupWithOpenAI(group, instruction, model) {
  const studentExercises = group
    .map((item, i) => {
      const seq = i + 1;
      const hasLeadingNumber = /^\s*\d+\s*\./.test(item.question || "");
      const question = hasLeadingNumber
        ? String(item.question).replace(/^\s*\d+\s*\./, `${seq}.`)
        : `${seq}. ${item.question}`;
      // Bài chuyển chủ động → bị động có "đề bài" là câu TIẾNG ANH, không phải
      // câu tiếng Việt cần dịch. Gắn nhãn [VIETNAMESE] cho nó là nói dối model,
      // và prompt sẽ chấm như một bài dịch hỏng.
      if (item.taskType === TASK_ACTIVE_PASSIVE) {
        return `\n[TASK]: ACTIVE_TO_PASSIVE\n[ACTIVE_SENTENCE]: ${question}\n[STUDENT_ANSWER]: ${item.answer}`;
      }
      return `\n[VIETNAMESE]: ${question}\n[STUDENT_ANSWER]: ${item.answer}`;
    })
    .join("\n");

  const inputText = `DATASET TO EVALUATE:\`\`\`\n${studentExercises}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;

  const aiResponse = await callGrader(instruction, inputText, model);
  const tableByStt = parseGradedTable(aiResponse);
  return group.map((_, i) => {
    const fb = tableByStt[String(i + 1)];
    return fb !== null && fb !== undefined && fb !== "" ? fb : null;
  });
}

/** Raised by gradeItemsCached when there is nothing gradable in `items`. */
class NoItemsError extends Error {}

/**
 * Grades a deduped batch of {question, answer, taskType} with the gradingCache
 * in front of the AI. Shared by /grade-cached (the website's old in-browser
 * flow) and background grading jobs (lib/gradingJobs.js).
 *
 * @returns {Promise<Array<{question, answer, taskType, feedback}>>} one result
 *   per ORIGINAL item, echoing the raw question/answer it was sent with.
 * @throws {NoItemsError} when no item has both a question and an answer.
 */
async function gradeItemsCached(items, { useCache = true, requestId } = {}) {
  const model = AI_MODEL;
  if (!Array.isArray(items) || items.length === 0) throw new NoItemsError();

  // 1. Dedupe by the CLEANED (question, answer, taskType): cleaning strips the
  //    "1." / "→" / trailing "." noise, so the same answer typed slightly
  //    differently shares one cache record and one AI grading. Each unique
  //    item remembers the ORIGINAL items mapped onto it — the FE rebuilds its
  //    lookup key from the raw text it sent, so the response echoes that.
  //    taskType THUỘC VỀ KHOÁ: một câu tiếng Anh giống hệt nhau có thể vừa là
  //    ĐÁP ÁN của bài dịch, vừa là ĐỀ BÀI của bài chuyển sang bị động. Thiếu
  //    nó, hai thứ đó sập thành MỘT item, chấm một lần, rồi cùng nhận một
  //    feedback sai loại.
  const uniqueMap = new Map();
  for (const item of items) {
    if (
      !item ||
      item.question === null ||
      item.question === undefined ||
      item.answer === null ||
      item.answer === undefined
    )
      continue;
    const taskType = normalizeTaskType(item.taskType ?? item.type);
    // Đoạn văn: cleanContent cắt dấu "." cuối MỖI dòng và mũi tên đầu dòng —
    // đúng cho một câu trả lời, sai cho một đoạn văn mà AI phải đọc nguyên
    // văn. Khoá cache vẫn qua gradingCacheKey (tự làm sạch) nên không lệch.
    const clean = taskType === TASK_PARAGRAPH ? paragraphText : cleanContent;
    const question = clean(item.question);
    const answer = clean(item.answer);
    if (!answer) continue;
    // Same normalization as the cache key, so two items never dedupe apart
    // yet land on one cache id.
    const key = JSON.stringify([
      normalizeForKey(question),
      normalizeForKey(answer),
      taskType,
    ]);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, { question, answer, taskType, originals: [] });
    }
    uniqueMap.get(key).originals.push({
      question: item.question,
      answer: item.answer,
      taskType,
    });
  }
  const uniqueItems = [...uniqueMap.values()];
  if (uniqueItems.length === 0) throw new NoItemsError();

  const cacheRef = db.collection("gradingCache");
  const ids = uniqueItems.map((it) =>
    gradingCacheId(it.question, it.answer, model, it.taskType),
  );

  // 2. Read existing feedback from the cache (chunked getAll). Skipped when
  //    caching is off, so every answer is treated as a miss and re-graded.
  const feedbackById = new Map();
  if (useCache) {
    const READ_CHUNK = 200;
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      const refs = ids.slice(i, i + READ_CHUNK).map((id) => cacheRef.doc(id));
      const snaps = await db.getAll(...refs);
      snaps.forEach((snap) => {
        if (snap.exists) {
          const data = snap.data();
          if (data && data.feedback !== null && data.feedback !== undefined) {
            feedbackById.set(snap.id, data.feedback);
          }
        }
      });
    }
  }

  // 3. Anything not in the cache is a miss to be graded.
  const uncached = [];
  uniqueItems.forEach((it, idx) => {
    if (!feedbackById.has(ids[idx])) uncached.push({ ...it, idx });
  });

  // 4. Grade misses with OpenAI, in modest groups, with bounded concurrency.
  if (uncached.length > 0) {
    const readInstruction = (fileName) => {
      const instructionFilePath = path.join(__dirname, fileName);
      if (!fs.existsSync(instructionFilePath)) {
        throw new Error(`Instruction file not found: ${instructionFilePath}`);
      }
      return fs.readFileSync(instructionFilePath, "utf8").trim();
    };
    const instruction = readInstruction(
      "prompt_and_instruction_for_responses_api_2.txt",
    );
    // Đoạn văn có prompt và định dạng output (JSON) riêng; chỉ đọc khi cần.
    const paragraphInstruction = uncached.some(
      (it) => it.taskType === TASK_PARAGRAPH,
    )
      ? readInstruction("prompt_paragraph.txt")
      : null;

    // Một đoạn văn dài hơn một câu cả chục lần, và output của nó cũng vậy —
    // nhóm nhỏ để một lần gọi không chạm trần token.
    const groupSizeOf = (taskType) => (taskType === TASK_PARAGRAPH ? 5 : 15);
    const groups = [];
    // Chia theo LOẠI BÀI trước khi chia theo kích thước: một lần gọi AI chỉ
    // được chứa một chế độ, nếu không thì phần đánh số lại 1..k trộn lẫn hai
    // kiểu đề và model phải đoán xem dòng nào là bài dịch, dòng nào là bài
    // bị động.
    for (const taskType of TASK_TYPES) {
      const ofType = uncached.filter((it) => it.taskType === taskType);
      const size = groupSizeOf(taskType);
      for (let i = 0; i < ofType.length; i += size) {
        groups.push(ofType.slice(i, i + size));
      }
    }

    const CONCURRENCY = Number(process.env.GRADE_GROUP_CONCURRENCY || 4);
    const groupErrors = [];
    const tasks = groups.map((group) => async () => {
      try {
        const feedbacks =
          group[0].taskType === TASK_PARAGRAPH
            ? await gradeParagraphGroup(group, {
                instruction: paragraphInstruction,
                model,
                callGrader,
              })
            : await gradeGroupWithOpenAI(group, instruction, model);
        group.forEach((it, i) => {
          const fb = feedbacks[i];
          if (fb !== null && fb !== undefined) {
            feedbackById.set(ids[it.idx], fb);
            it._feedback = fb; // mark for cache write
          }
        });
      } catch (err) {
        // A failed group leaves its items uncached/unwritten; they retry on
        // the next run. Never block the whole class on one group.
        groupErrors.push(err);
        console.error("[GRADE-CACHED] group grading failed:", err.message);
      }
    });
    await runWithConcurrency(tasks, CONCURRENCY);

    // Opportunistic DeepSeek balance check (throttled to ~1/hour inside).
    // Deliberately NOT awaited and NOT in res.on("finish"): steps 5-7 below
    // still run, so this finishes while Cloud Run still guarantees CPU.
    // Placed BEFORE the "every group failed" throw on purpose — a drained
    // account is exactly what makes every group fail, so this is the most
    // valuable moment to look. .catch() is mandatory: an unhandled rejection
    // would take the process down.
    balanceMonitor
      .maybeCheckAndAlert({
        db,
        admin,
        adminEmails: ADMIN_EMAILS,
        requestId,
      })
      .catch((err) => console.error("[BALANCE] check failed:", err.message));

    // If EVERY group failed (e.g. a misconfigured AI key/model in this
    // environment), the AI produced no feedback at all. Returning
    // success:true with all-null feedback hides a total outage, so surface
    // it as a real error instead. Partial failures still pass through and
    // retry on the next run.
    const graded = uncached.some(
      (it) => it._feedback !== null && it._feedback !== undefined,
    );
    if (!graded && groupErrors.length > 0) {
      const cause = groupErrors[0];
      const err = new Error(
        `AI grading failed for all ${uncached.length} item(s): ${cause.message || cause}`,
      );
      err.status = cause.status; // preserve upstream status (e.g. 401) for logs
      throw err;
    }

    // 5. Persist newly graded feedback (chunked batch writes, <500/batch).
    //    Skipped when caching is off — AI feedback is not stored.
    if (useCache) {
      const toWrite = uncached.filter(
        (it) => it._feedback !== null && it._feedback !== undefined,
      );
      const WRITE_CHUNK = 400;
      for (let i = 0; i < toWrite.length; i += WRITE_CHUNK) {
        const batch = db.batch();
        toWrite.slice(i, i + WRITE_CHUNK).forEach((it) => {
          batch.set(cacheRef.doc(ids[it.idx]), {
            question: it.question,
            answer: it.answer,
            feedback: it._feedback,
            model: model,
            promptVersion: PROMPT_VERSION,
            taskType: it.taskType,
            hitCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
      }
    }
  }

  // 6. Bump hitCount for items served from the cache (best effort).
  const uncachedIds = new Set(uncached.map((it) => ids[it.idx]));
  const hitIds = ids.filter(
    (id) => !uncachedIds.has(id) && feedbackById.has(id),
  );
  const HIT_CHUNK = 400;
  for (let i = 0; i < hitIds.length; i += HIT_CHUNK) {
    const batch = db.batch();
    hitIds.slice(i, i + HIT_CHUNK).forEach((id) => {
      batch.update(cacheRef.doc(id), {
        hitCount: admin.firestore.FieldValue.increment(1),
      });
    });
    await batch.commit();
  }

  // 7. Return feedback per unique (question, answer, taskType). The FE maps
  //    these back to each student by the same triple.
  //
  //    `taskType` BẮT BUỘC có mặt: FE dựng lại khoá tra cứu TỪ RESPONSE NÀY,
  //    nên bỏ nó đi thì mọi lookup trượt và KHÔNG tài liệu nào được ghi —
  //    lỗi im lặng, không có ngoại lệ nào được ném ra để lần theo.
  //    One result per ORIGINAL item, echoing the raw question/answer the FE
  //    sent (the cache and the AI only ever see the cleaned text).
  return uniqueItems.flatMap((it, idx) =>
    it.originals.map((orig) => ({
      ...orig,
      feedback: feedbackById.get(ids[idx]) ?? null,
    })),
  );
}

app.post("/grade-cached", verifyGoogleToken, async (req, res) => {
  // Only admins may turn the cache OFF; everyone else always uses it. When off,
  // we skip the cache lookup (every answer goes to the AI) and skip persisting
  // the AI feedback to gradingCache.
  const isAdmin = ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase());
  const useCache = !(isAdmin && req.body.useCache === false);

  if (!Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ error: "no_items_provided" });
  }

  // Audit detail for this run. The default (a truncated dump of `items`) tells
  // an admin nothing, so name the class and lesson and say how much work this
  // run represents. Never let a failure here break the grading itself.
  try {
    const [classSnap, lessonSnap] = await Promise.all([
      req.body.classId
        ? db.collection("classes").doc(String(req.body.classId)).get()
        : null,
      req.body.lessonId
        ? db.collection("lesson").doc(String(req.body.lessonId)).get()
        : null,
    ]);
    res.locals.auditDetail =
      `Lớp: ${classSnap?.data()?.name || "?"} · ` +
      `Buổi: ${lessonSnap?.data()?.name || "?"} · ` +
      `Số bài chưa chấm: ${Number(req.body.pendingCount) || 0}`;
  } catch (err) {
    console.error("[GRADE-CACHED] audit detail failed:", err);
  }

  try {
    const results = await gradeItemsCached(req.body.items, {
      useCache,
      requestId: req.requestId,
    });
    return res.json({ success: true, results });
  } catch (err) {
    if (err instanceof NoItemsError) {
      return res.status(400).json({ error: "no_items_provided" });
    }
    console.error("[GRADE-CACHED] Error:", err);
    return res.status(500).json({
      error: "grading_failed",
      details: err.message || "Unknown Error",
    });
  }
});

// ---------------------------------------------------------------------------
// gradingCache management (admin only) — list/search, add, edit, delete.
// All endpoints require a registered token AND an admin email (requireAdmin).
// ---------------------------------------------------------------------------

/** Whitelist the fields a client may write, coercing types. */
function sanitizeCacheInput(body, existing = {}) {
  const out = { ...existing };
  // Cleaned the same way as the grading flow, so a record added here is stored
  // (and keyed) exactly like one the grader would have written.
  if (body.question !== null && body.question !== undefined)
    out.question = cleanContent(body.question);
  if (body.answer !== null && body.answer !== undefined)
    out.answer = cleanContent(body.answer);
  if (body.feedback !== null && body.feedback !== undefined)
    out.feedback = String(body.feedback);
  if (body.model !== null && body.model !== undefined)
    out.model = String(body.model);
  if (body.promptVersion !== null && body.promptVersion !== undefined)
    out.promptVersion = String(body.promptVersion);
  if (body.hitCount !== null && body.hitCount !== undefined)
    out.hitCount = Number(body.hitCount) || 0;
  // Bản ghi cũ không có trường này; mặc định về bài dịch để khoá không đổi.
  out.taskType = normalizeTaskType(body.taskType ?? existing.taskType);
  return out;
}

/**
 * GET /grading-cache?field=&q=&page=&pageSize= — substring search
 * (case-insensitive) with server-side paging (max 100/page). Substring match
 * isn't indexable in Firestore, so we read the collection, filter + sort in
 * memory, then return only the requested page plus the total count.
 */
app.get("/grading-cache", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const field = GRADING_CACHE_FIELDS.includes(req.query.field)
      ? req.query.field
      : "question";
    const q = (req.query.q || "").toString().toLowerCase();
    const pageSize = Math.min(
      Math.max(Number(req.query.pageSize) || 100, 1),
      100,
    );
    const page = Math.max(Number(req.query.page) || 1, 1);

    const snapshot = await db.collection("gradingCache").get();
    let rows = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      rows.push({
        id: doc.id,
        question: data.question ?? "",
        answer: data.answer ?? "",
        feedback: data.feedback ?? "",
        model: data.model ?? "",
        promptVersion: data.promptVersion ?? "",
        hitCount: data.hitCount ?? 0,
        createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
      });
    });

    if (q) {
      rows = rows.filter((row) =>
        String(row[field] ?? "")
          .toLowerCase()
          .includes(q),
      );
    }
    // Newest first; rows without createdAt sort last.
    rows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    const total = rows.length;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const results = rows.slice(start, start + pageSize);

    return res.json({ results, total, page: safePage, pageSize, totalPages });
  } catch (err) {
    console.error("[GRADING-CACHE] list error:", err);
    return res.status(500).json({ error: "failed_to_list" });
  }
});

/** POST /grading-cache — add one record (id derived from key fields). */
app.post(
  "/grading-cache",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const data = sanitizeCacheInput(req.body);
      if (!data.question || !data.answer || !data.feedback) {
        return res
          .status(400)
          .json({ error: "question_answer_feedback_required" });
      }
      data.model = data.model || AI_MODEL;
      data.promptVersion = data.promptVersion || PROMPT_VERSION;
      data.hitCount = data.hitCount || 0;

      const id = gradingCacheKey(
        data.promptVersion,
        data.model,
        data.question,
        data.answer,
        data.taskType,
      );
      const ref = db.collection("gradingCache").doc(id);
      if ((await ref.get()).exists) {
        return res.status(409).json({ error: "already_exists" });
      }
      await ref.set({
        ...data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(201).json({ id, ...data });
    } catch (err) {
      console.error("[GRADING-CACHE] create error:", err);
      return res.status(500).json({ error: "failed_to_create" });
    }
  },
);

/**
 * PATCH /grading-cache/:id — edit any field. If a KEY field
 * (question/answer/model/promptVersion) changes, the doc id is re-derived so
 * the grading flow still finds it: the doc is moved to the new id.
 */
app.patch(
  "/grading-cache/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const id = req.params.id;
      const ref = db.collection("gradingCache").doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "not_found" });
      }

      const existing = snap.data();
      const merged = sanitizeCacheInput(req.body, existing);
      if (!merged.question || !merged.answer || !merged.feedback) {
        return res
          .status(400)
          .json({ error: "question_answer_feedback_required" });
      }
      merged.model = merged.model || AI_MODEL;
      merged.promptVersion = merged.promptVersion || PROMPT_VERSION;
      merged.hitCount = merged.hitCount ?? 0;

      const newId = gradingCacheKey(
        merged.promptVersion,
        merged.model,
        merged.question,
        merged.answer,
        merged.taskType,
      );

      if (newId === id) {
        // Only non-key fields changed (e.g. feedback/hitCount) — update in place.
        await ref.update({
          question: merged.question,
          answer: merged.answer,
          feedback: merged.feedback,
          model: merged.model,
          promptVersion: merged.promptVersion,
          taskType: merged.taskType,
          hitCount: merged.hitCount,
        });
        return res.json({ id, ...merged });
      }

      // Key field changed → re-key. Refuse if it would clobber another record.
      const newRef = db.collection("gradingCache").doc(newId);
      if ((await newRef.get()).exists) {
        return res.status(409).json({ error: "key_conflict" });
      }
      const batch = db.batch();
      batch.set(newRef, {
        ...merged,
        createdAt:
          existing.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
      });
      batch.delete(ref);
      await batch.commit();
      return res.json({ id: newId, ...merged });
    } catch (err) {
      console.error("[GRADING-CACHE] update error:", err);
      return res.status(500).json({ error: "failed_to_update" });
    }
  },
);

/** DELETE /grading-cache/:id */
app.delete(
  "/grading-cache/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const ref = db.collection("gradingCache").doc(req.params.id);
      if (!(await ref.get()).exists) {
        return res.status(404).json({ error: "not_found" });
      }
      await ref.delete();
      return res.json({ success: true });
    } catch (err) {
      console.error("[GRADING-CACHE] delete error:", err);
      return res.status(500).json({ error: "failed_to_delete" });
    }
  },
);

/** POST /grading-cache/bulk-delete — delete many records by id at once. */
app.post(
  "/grading-cache/bulk-delete",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids)
        ? [...new Set(req.body.ids.filter((x) => typeof x === "string" && x))]
        : [];
      if (ids.length === 0) {
        return res.status(400).json({ error: "no_ids" });
      }
      const cacheRef = db.collection("gradingCache");
      const CHUNK = 400; // Firestore batch limit is 500.
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = db.batch();
        ids.slice(i, i + CHUNK).forEach((id) => batch.delete(cacheRef.doc(id)));
        await batch.commit();
      }
      return res.json({ deleted: ids.length });
    } catch (err) {
      console.error("[GRADING-CACHE] bulk-delete error:", err);
      return res.status(500).json({ error: "failed_to_bulk_delete" });
    }
  },
);

// ---------------------------------------------------------------------------
// Audit log — read side. Entries are written by auditMiddleware above; nothing
// here creates them except the narrow client-event endpoint (logout).
// Admin-only, matching the /admin/audit-logs screen on the website.
// ---------------------------------------------------------------------------

/**
 * Filterable fields and how their values are matched:
 *   "enum" → comma-separated list, exact match, OR semantics (multiselect UI)
 *   "text" → case-insensitive substring (free-text UI)
 */
const AUDIT_FILTER_FIELDS = {
  action: "enum",
  resourceType: "enum",
  severity: "enum",
  method: "enum",
  success: "enum",
  actorEmail: "text",
  actorName: "text",
  entityId: "text",
  path: "text",
  detail: "text",
  ip: "text",
  requestId: "text",
};

const AUDIT_PAGE_SIZE_MAX = 100;
const AUDIT_DEFAULT_WINDOW_DAYS = 7;

/** GET /audit-logs/filter-options — dropdown values for the enum filters. */
app.get(
  "/audit-logs/filter-options",
  verifyGoogleToken,
  requireAdmin,
  (req, res) => {
    // Derived from the AUDIT_ACTIONS table, so the UI never hard-codes actions.
    return res.json({
      fields: AUDIT_FILTER_FIELDS,
      options: auditActions.filterOptions(),
    });
  },
);

/**
 * GET /audit-logs — paged, filtered audit trail (newest first).
 *
 * The date range is the only Firestore-side filter, so the query needs no
 * composite index; field/q filtering happens in memory afterwards, which is
 * comfortable at this scale (30-day retention, tens of teachers).
 * SCALING NOTE: past roughly 50k documents in the retention window, move the
 * enum filters (action / resourceType / severity) into .where() clauses and add
 * the matching composite indexes with createdAt.
 */
app.get("/audit-logs", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const field = Object.prototype.hasOwnProperty.call(
      AUDIT_FILTER_FIELDS,
      req.query.field,
    )
      ? req.query.field
      : "action";
    const fieldType = AUDIT_FILTER_FIELDS[field];
    const rawQuery = (req.query.q || "").toString().trim();

    const pageSize = Math.min(
      Math.max(Number(req.query.pageSize) || 50, 1),
      AUDIT_PAGE_SIZE_MAX,
    );
    const page = Math.max(Number(req.query.page) || 1, 1);

    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(Date.now() - AUDIT_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    // A date-only "to" means the whole of that day.
    const to = req.query.to
      ? new Date(`${req.query.to}T23:59:59.999`)
      : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: "invalid_date_range" });
    }

    const snapshot = await db
      .collection("auditLogs")
      .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(from))
      .where("createdAt", "<=", admin.firestore.Timestamp.fromDate(to))
      .orderBy("createdAt", "desc")
      .get();

    let rows = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      rows.push({
        id: doc.id,
        requestId: data.requestId ?? "",
        createdAt: data.createdAt?.toDate?.().toISOString() ?? null,
        actorEmail: data.actorEmail ?? "",
        actorName: data.actorName ?? "",
        actorResolvedFrom: data.actorResolvedFrom ?? "unknown",
        action: data.action ?? "",
        resourceType: data.resourceType ?? "",
        severity: data.severity ?? "INFO",
        method: data.method ?? "",
        path: data.path ?? "",
        entityId: data.entityId ?? "",
        statusCode: data.statusCode ?? null,
        success: data.success !== false,
        durationMs: data.durationMs ?? null,
        detail: data.detail ?? "",
        ip: data.ip ?? "",
      });
    });

    if (rawQuery) {
      if (fieldType === "enum") {
        const wanted = new Set(
          rawQuery
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        if (wanted.size > 0) {
          rows = rows.filter((row) => wanted.has(String(row[field])));
        }
      } else {
        const needle = rawQuery.toLowerCase();
        rows = rows.filter((row) =>
          String(row[field] ?? "")
            .toLowerCase()
            .includes(needle),
        );
      }
    }

    const total = rows.length;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const results = rows.slice(start, start + pageSize);

    return res.json({ results, total, page: safePage, pageSize, totalPages });
  } catch (err) {
    console.error("[AUDIT] list error:", err);
    return res.status(500).json({ error: "failed_to_list" });
  }
});

/**
 * POST /audit-logs/client-event — records the few actions that never reach a
 * route of their own (logout). Only whitelisted action names are accepted and
 * the actor always comes from the token, so a client cannot forge entries.
 */
app.post("/audit-logs/client-event", verifyGoogleToken, async (req, res) => {
  const action = String(req.body?.action || "");
  const config = auditActions.CLIENT_ACTIONS[action];
  if (!config) {
    return res.status(400).json({ error: "unknown_client_action" });
  }
  const actor = await auditLog.resolveActor(db, req.userEmail);
  await auditLog.recordAudit(db, admin, {
    requestId: req.requestId,
    actorEmail: req.userEmail,
    actorName: actor.name,
    actorId: actor.id,
    actorResolvedFrom: "token",
    action,
    resourceType: config.resourceType,
    severity: config.severity,
    method: "CLIENT",
    path: `/client/${action}`,
    statusCode: 200,
    success: true,
    durationMs: 0,
    detail: "",
    ip: (req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip,
    userAgent: req.headers["user-agent"] || "",
  });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Notifications — the in-app bell + FCM web-push device registry.
//
// Two producers today: the DeepSeek balance monitor (lib/balanceMonitor.js),
// addressed to ADMIN_EMAILS, and "an admin graded on your behalf", addressed to
// the class's own teacher (see POST /grading-summary).
//
// AUTHORISATION IS BY RECIPIENT, NOT BY ROLE — which is why these routes carry
// verifyGoogleToken but deliberately NOT requireAdmin. Every read is scoped to
// req.userEmail through the `recipients` array inside lib/notifications.js, so a
// teacher sees their own notifications and cannot see an admin's balance alert
// (their address is not in its recipients; mark-read on it returns 404). Adding
// requireAdmin back would not harden anything — it would just lock teachers out
// of their own bell.
//
// GET /notifications is deliberately NOT in AUDITED_GETS — the bell polls it
// every 60s per open tab, and auditing it would bury the real actions, exactly
// like /auth/refresh already does via SKIP_PATHS.
// ---------------------------------------------------------------------------

app.get("/notifications", verifyGoogleToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const result = await notifications.listNotifications(db, {
      email: req.userEmail,
      limit,
      unreadOnly: req.query.status === "unread",
    });
    return res.json(result);
  } catch (err) {
    console.error("[NOTIFY] list failed:", err.message);
    return res.status(500).json({ error: "notifications_list_failed" });
  }
});

// The "all notifications" page. Filters are validated against fixed lists so a
// typo answers 400 instead of silently returning everything.
app.get("/notifications/search", verifyGoogleToken, async (req, res) => {
  const {
    status = "all",
    category = "all",
    severity = "all",
    since = "",
  } = req.query;
  if (
    !notifications.SEARCH_STATUSES.includes(status) ||
    !notifications.SEARCH_CATEGORIES.includes(category) ||
    !notifications.SEARCH_SEVERITIES.includes(severity) ||
    (since && Number.isNaN(Date.parse(since)))
  ) {
    return res.status(400).json({ error: "invalid_filter" });
  }
  try {
    const result = await notifications.searchNotifications(db, {
      email: req.userEmail,
      status,
      category,
      severity,
      since: since || null,
    });
    return res.json(result);
  } catch (err) {
    console.error("[NOTIFY] search failed:", err.message);
    return res.status(500).json({ error: "notifications_search_failed" });
  }
});

app.post("/notifications/read-all", verifyGoogleToken, async (req, res) => {
  try {
    const count = await notifications.markAllRead(db, admin, req.userEmail);
    res.locals.auditDetail = `Đánh dấu đã đọc ${count} thông báo`;
    return res.json({ ok: true, count });
  } catch (err) {
    console.error("[NOTIFY] read-all failed:", err.message);
    return res.status(500).json({ error: "notifications_read_all_failed" });
  }
});

app.post("/notifications/:id/read", verifyGoogleToken, async (req, res) => {
  try {
    const ok = await notifications.markRead(
      db,
      admin,
      req.params.id,
      req.userEmail,
    );
    if (!ok) return res.status(404).json({ error: "notification_not_found" });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[NOTIFY] read failed:", err.message);
    return res.status(500).json({ error: "notification_read_failed" });
  }
});

/**
 * Registers (or refreshes) this browser's FCM token.
 *
 * The body field is named `token` ON PURPOSE: auditLog's REDACT_KEYS masks it,
 * so the raw registration token — a capability to push to that device — never
 * lands in an audit row. That leaves the audit body useless, hence the explicit
 * auditDetail below. The response returns only the SHA-256 hash, which is what
 * the client stores and what the unregister URL carries.
 */
app.post("/notifications/devices", verifyGoogleToken, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "missing_token" });

  try {
    const teacher = await findTeacherByEmail(req.userEmail);
    const { tokenHash, created } = await pushDevices.saveDevice(db, admin, {
      token,
      email: req.userEmail,
      teacherId: teacher?.id || null,
      userAgent: req.headers["user-agent"] || "",
      platform: String(req.body?.platform || "web"),
    });
    res.locals.auditDetail =
      `FCM device ${tokenHash.slice(0, 12)}… ` +
      `(${req.body?.platform || "web"}) cho ${req.userEmail}` +
      (created ? " — đăng ký mới" : " — làm mới");
    return res.json({ ok: true, tokenHash });
  } catch (err) {
    console.error("[PUSH] register failed:", err.message);
    return res.status(500).json({ error: "device_register_failed" });
  }
});

app.delete(
  "/notifications/devices/:tokenHash",
  verifyGoogleToken,
  async (req, res) => {
    try {
      const removed = await pushDevices.removeDevice(
        db,
        req.params.tokenHash,
        req.userEmail,
      );
      res.locals.auditDetail = `Huỷ đăng ký FCM device ${String(
        req.params.tokenHash,
      ).slice(0, 12)}…`;
      return res.json({ ok: true, removed });
    } catch (err) {
      console.error("[PUSH] unregister failed:", err.message);
      return res.status(500).json({ error: "device_unregister_failed" });
    }
  },
);

/**
 * Manual DeepSeek balance check. `?force=1` bypasses BOTH the hourly throttle
 * and the re-alert gate, which is what makes the feature testable without
 * waiting an hour or actually draining the account (raise the threshold env var
 * instead — see the plan's verification section).
 */
app.post(
  "/admin/deepseek-balance/check",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const force = ["1", "true", "yes"].includes(
        String(req.query.force || "").toLowerCase(),
      );
      const result = await balanceMonitor.maybeCheckAndAlert({
        db,
        admin,
        adminEmails: ADMIN_EMAILS,
        force,
        requestId: req.requestId,
      });
      res.locals.auditDetail = result.skipped
        ? `Bỏ qua: ${result.skipped}`
        : `${result.evaluation?.reason || "?"} — ${
            result.alerted ? "đã gửi cảnh báo" : "không cảnh báo"
          }`;
      return res.json(result);
    } catch (err) {
      console.error("[BALANCE] manual check failed:", err.message);
      return res.status(500).json({ error: "balance_check_failed" });
    }
  },
);

// ---------------------------------------------------------------------------
// TeacherPoint — each teacher's balance IN VND (`balanceVnd`; the collection
// keeps its old name). Each student doc whose feedback is written costs 800đ by
// hand, 700đ in a scheduled run (lib/billing.js). A top-up of N đ credits N đ
// and adds N × 6/7 to the admin's revenue (the saler keeps N/7).
// Admin-only CRUD + top-up. Teachers only read their own balance / consume it.
// ---------------------------------------------------------------------------

/** Resolves the teacher doc for the authenticated user (by gmail). */
async function findTeacherByEmail(email) {
  const snap = await db
    .collection("teachers")
    .where("gmail", "==", (email || "").toLowerCase())
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Resolves WHO PAYS for grading a class.
 *
 * Admins grade on behalf of the class's teacher, so the class record decides;
 * everyone else pays for themselves. Always resolved here from `classes`, never
 * taken from the request body — otherwise a teacher could bill someone else.
 * A class carries `teacherId` as an ARRAY; the first entry is the owner.
 */
async function resolvePayer(callerEmail, classId) {
  const isAdmin = ADMIN_EMAILS.includes((callerEmail || "").toLowerCase());
  if (!isAdmin) return findTeacherByEmail(callerEmail);
  if (!classId) return null;
  const classSnap = await db.collection("classes").doc(String(classId)).get();
  if (!classSnap.exists) return null;
  const teacherIds = Array.isArray(classSnap.data().teacherId)
    ? classSnap.data().teacherId
    : [];
  if (!teacherIds.length) return null; // class with no teacher — nobody to bill
  const snap = await db.collection("teachers").doc(teacherIds[0]).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/** Current point balance of the logged-in teacher (0 when no record yet). */
app.get("/teacher-points/me", verifyGoogleToken, async (req, res) => {
  try {
    // Resolve through the teacher record: TeacherPoint is keyed BY TEACHER ID
    // and that is the doc /teacher-points/consume debits. Querying by gmail
    // here instead would read one record while the charge lands on another.
    const prices = {
      priceManualVnd: billing.PRICE_MANUAL_VND,
      priceAutoVnd: billing.PRICE_AUTO_VND,
    };
    const teacher = await findTeacherByEmail(req.userEmail);
    if (!teacher) return res.json({ balanceVnd: 0, ...prices });
    const balanceVnd = await teacherPoints.readBalanceVnd(db, teacher.id);
    return res.json({ balanceVnd, ...prices });
  } catch (err) {
    console.error("[TEACHER-POINTS] me error:", err);
    return res.status(500).json({ error: "failed_to_get_point" });
  }
});

/**
 * Balance of whoever pays for grading this class — the class's teacher when an
 * admin is grading, the caller otherwise. Lets the grading screen check the
 * right person's balance before it writes anything into a student doc.
 */
app.get("/teacher-points/payer", verifyGoogleToken, async (req, res) => {
  try {
    const payer = await resolvePayer(req.userEmail, req.query.classId);
    if (!payer) return res.status(403).json({ error: "payer_not_found" });
    return res.json({
      balanceVnd: await teacherPoints.readBalanceVnd(db, payer.id),
      teacherId: payer.id,
      teacherName: payer.name || payer.gmail || "",
    });
  } catch (err) {
    console.error("[TEACHER-POINTS] payer error:", err);
    return res.status(500).json({ error: "failed_to_get_payer" });
  }
});

/** See lib/teacherPoints.js — bound to this server's Firestore. */
const consumePointsForDocs = (charge) =>
  teacherPoints.consumePointsForDocs(db, admin, charge);

app.post("/teacher-points/consume", verifyGoogleToken, async (req, res) => {
  try {
    const docIds = [
      ...new Set(
        (Array.isArray(req.body.docIds) ? req.body.docIds : [])
          .filter(Boolean)
          .map(String),
      ),
    ];
    if (!docIds.length || docIds.length > 10) {
      return res.status(400).json({ error: "invalid_doc_ids" });
    }
    const payer = await resolvePayer(req.userEmail, req.body.classId);
    if (!payer) {
      return res.status(403).json({ error: "payer_not_found" });
    }

    const result = await consumePointsForDocs({
      payer,
      docIds,
      classId: req.body.classId,
      lessonId: req.body.lessonId,
      chargedByEmail: req.userEmail,
      // Graded in the browser, by hand.
      unitPriceVnd: billing.PRICE_MANUAL_VND,
    });

    if (result.need) {
      return res.status(402).json({
        error: "insufficient_points",
        balanceVnd: result.balanceVnd,
        need: result.need,
        needVnd: result.needVnd,
      });
    }
    return res.json({
      balanceVnd: result.balanceVnd,
      charged: result.charged,
      chargedVnd: result.chargedVnd,
      payerTeacherId: payer.id,
      payerName: payer.name || payer.gmail || "",
    });
  } catch (err) {
    console.error("[TEACHER-POINTS] consume error:", err);
    return res.status(500).json({ error: "failed_to_consume" });
  }
});

/**
 * Grades ONE pasted IELTS Writing submission (the website's "Chấm IELTS
 * Writing" page) and returns the three-part feedback.
 *
 * Billing reuses consumePointsForDocs, the same receipts as Basic: the receipt
 * "doc" is the submission itself (pasteReceiptDocId: task + prompt + essay +
 * charts), so the same teacher grading the same submission again pays once.
 * The balance is checked BEFORE the model is called and the point is taken
 * only AFTER a valid result exists — a failed grading costs nothing.
 *
 * Who pays: an admin who picks a class bills that class's teacher (as Basic
 * does); without a class, and for every teacher, the caller pays.
 */
app.post("/ielts-writing/grade", verifyToken, async (req, res) => {
  if (!ieltsConfigured) {
    return res.status(503).json({ error: "ielts_not_configured" });
  }
  let input;
  try {
    input = ieltsWriting.validateRequest(req.body);
  } catch (err) {
    if (err instanceof ieltsWriting.IeltsError) {
      return res
        .status(err.status)
        .json({ error: err.code, ...(err.params || {}) });
    }
    throw err;
  }

  try {
    const email = String(req.userEmail || "").toLowerCase();
    const isAdmin = ADMIN_EMAILS.includes(email);
    const classId = req.body.classId ? String(req.body.classId) : null;
    const payer = classId
      ? await resolvePayer(email, classId)
      : await findTeacherByEmail(email);
    if (!payer) return res.status(403).json({ error: "payer_not_found" });

    let graded;
    try {
      graded = await ieltsPaste.gradePasted(
        { db, grader: ieltsGrader, consumePoints: consumePointsForDocs },
        {
          payer,
          input,
          classId,
          email,
          useCache: isAdmin ? req.body.useCache !== false : true,
          requestId: req.requestId,
        },
      );
    } catch (err) {
      if (
        err instanceof ieltsWriting.IeltsError ||
        err instanceof ieltsPaste.PasteError
      ) {
        res.locals.auditDetail = `IELTS ${input.task} · ${err.code}`;
        return res
          .status(err.status)
          .json({ error: err.code, ...(err.params || {}) });
      }
      throw err;
    }

    const { result, feedback, cached, charged, chargedVnd, balanceVnd } =
      graded;
    const { chartData } = graded;
    res.locals.auditDetail =
      `IELTS ${input.task} · ${result.wordCount} từ · Overall ` +
      `${result.overall ?? "-"} · ${cached ? "cache" : "AI"} · ` +
      `trừ ${billing.formatVnd(chargedVnd)}`;
    return res.json({
      result,
      feedback,
      cached,
      charged,
      chargedVnd,
      balanceVnd,
      payerName: payer.name || payer.gmail || "",
      chartData: chartData || null,
    });
  } catch (err) {
    console.error("[IELTS] grade error:", err);
    return res.status(500).json({ error: "ielts_grade_failed" });
  }
});

/**
 * One audit line closing out a grading run: which class, which lesson, how many
 * points it cost. The individual charges are deliberately NOT audited (there
 * are many per run) — TeacherPointLedger is the per-doc record of the spend.
 */
/**
 * Notifies a teacher that an admin graded their class on their behalf.
 *
 * Only fires when the caller is an admin AND the payer resolved to somebody
 * else — an admin grading their own class, or a teacher grading normally, is
 * not news to anyone.
 *
 * Deduplicated per class + lesson + DAY via the deterministic notification id,
 * so several runs on the same lesson in one day collapse onto a single bell
 * entry. Rewriting that entry deliberately resets readBy and bumps createdAt
 * (see createNotification), so a later run pops back to the top as unread
 * instead of silently updating something already dismissed.
 *
 * Never throws: the caller fires it without awaiting.
 */
async function notifyTeacherGradedByAdmin({
  actorEmail,
  payer,
  classSnap,
  lessonSnap,
  classId,
  lessonId,
  totalPoints,
  requestId,
}) {
  const actor = String(actorEmail || "").toLowerCase();
  const recipient = String(payer?.gmail || "").toLowerCase();

  const isAdmin = ADMIN_EMAILS.includes(actor);
  if (!isAdmin || !recipient || recipient === actor) return;
  // A closed account should not be pinged, and cannot log in to read it anyway.
  if (payer?.isAccountActive === false) return;
  // classId is what the whole notification is keyed on; without it there is
  // nothing meaningful to dedupe against.
  const classKey = typeof classId === "string" ? classId.trim() : "";
  if (!classKey) return;

  const lessonKey = typeof lessonId === "string" ? lessonId.trim() : "";
  const className = classSnap?.data()?.name || "?";
  const lessonName = lessonSnap?.data()?.name || "?";
  // totalPoints comes straight from the browser — display only, never trusted.
  const count = Math.max(0, Math.trunc(Number(totalPoints) || 0));

  const title = "Admin đã chấm bài giúp bạn";
  const body =
    `Lớp ${className} · Buổi ${lessonName}` +
    (count > 0 ? ` · ${count} bài đã được chấm.` : ".");

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const id = notifications.notificationId(
    "grading.doneByAdmin",
    `${classKey}|${lessonKey}`,
    day,
  );

  const notificationId = await notifications.createNotification(db, admin, {
    id,
    type: "grading.doneByAdmin",
    severity: "INFO",
    title,
    body,
    data: {
      className,
      lessonName,
      totalPoints: count,
      classId: classKey,
      lessonId: lessonKey || null,
      byEmail: actor,
    },
    recipients: [recipient],
    sourceRequestId: requestId || null,
  });

  // Push is the best-effort half; the bell entry above is already durable.
  try {
    const devices = await pushDevices.listActiveTokens(db, [recipient]);
    const push = await pushDevices.sendPush(admin, db, {
      tokens: devices,
      title,
      body,
      data: { type: "grading.doneByAdmin", notificationId },
      link: process.env.PUBLIC_WEB_URL || undefined,
    });
    await notifications.recordPushResult(db, admin, notificationId, push);
  } catch (err) {
    console.error("[NOTIFY] graded-by-admin push failed:", err.message);
  }

  // No HTTP request of its own produced this, so the middleware cannot see it.
  const descriptor = auditActions.SYSTEM_ACTIONS["grading.notifiedTeacher"];
  await auditLog.recordAudit(db, admin, {
    requestId: requestId || null,
    actorEmail: actor,
    actorResolvedFrom: "token",
    action: "grading.notifiedTeacher",
    resourceType: descriptor.resourceType,
    severity: descriptor.severity,
    method: "SYSTEM",
    path: "/system/graded-by-admin",
    entityId: notificationId,
    success: true,
    detail: `Báo cho ${recipient}: ${body}`,
  });
}

app.post("/grading-summary", verifyGoogleToken, async (req, res) => {
  try {
    const [payer, classSnap, lessonSnap] = await Promise.all([
      resolvePayer(req.userEmail, req.body.classId),
      req.body.classId
        ? db.collection("classes").doc(String(req.body.classId)).get()
        : null,
      req.body.lessonId
        ? db.collection("lesson").doc(String(req.body.lessonId)).get()
        : null,
    ]);
    // The amount leads: the audit screen clips the detail column at 220px, so
    // whatever comes first is the only part read without hovering.
    // totalPoints counts docs graded by hand (the browser path).
    res.locals.auditDetail =
      `Tổng tiền bị trừ: ${billing.formatVnd(
        (Number(req.body.totalPoints) || 0) * billing.PRICE_MANUAL_VND,
      )} · ` +
      `Lớp: ${classSnap?.data()?.name || "?"} · ` +
      `Buổi: ${lessonSnap?.data()?.name || "?"} · ` +
      `GV: ${payer?.name || payer?.gmail || "?"}`;

    // Tell the teacher when an ADMIN graded their class for them. Best effort
    // and fully isolated: this route exists to record an audit line, so a
    // failure here must never turn into an error the grading run sees.
    notifyTeacherGradedByAdmin({
      actorEmail: req.userEmail,
      payer,
      classSnap,
      lessonSnap,
      classId: req.body.classId,
      lessonId: req.body.lessonId,
      totalPoints: req.body.totalPoints,
      requestId: req.requestId,
    }).catch((err) =>
      console.error("[NOTIFY] graded-by-admin failed:", err.message),
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("[TEACHER-POINTS] grading summary error:", err);
    return res.status(500).json({ error: "failed_to_record_summary" });
  }
});

/**
 * One audit line for a "clear feedback" run. Like /grading-summary, the real
 * work happens browser-side against the Docs API, so nothing else would record
 * it. Admin-only, mirroring the button that triggers it.
 */
app.post(
  "/feedback-clear-summary",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      // Firestore .doc("") throws, and String() on an array/object yields a
      // junk id ("a,b", "[object Object]") — reject both up front.
      const classId = String(req.body?.classId || "");
      const lessonId = String(req.body?.lessonId || "");
      if (!classId || !lessonId) {
        return res
          .status(400)
          .json({ error: "classId and lessonId are required" });
      }
      const clearedDocs = Math.max(0, Number(req.body?.clearedDocs) || 0);
      const clearedCells = Math.max(0, Number(req.body?.clearedCells) || 0);

      const [classSnap, lessonSnap] = await Promise.all([
        db.collection("classes").doc(classId).get(),
        db.collection("lesson").doc(lessonId).get(),
      ]);
      res.locals.auditDetail =
        `Số ô đã xóa: ${clearedCells} · ` +
        `Số tài liệu: ${clearedDocs} · ` +
        `Lớp: ${classSnap.data()?.name || "?"} · ` +
        `Buổi: ${lessonSnap.data()?.name || "?"}`;
      return res.json({ ok: true });
    } catch (err) {
      console.error("[FEEDBACK-CLEAR] summary error:", err);
      return res.status(500).json({ error: "failed_to_record_summary" });
    }
  },
);

/** Admin: list teachers (for the create dropdown). */
app.get("/teachers", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection("teachers").get();
    const teachers = [];
    snap.forEach((doc) => {
      const d = doc.data();
      // teachers.push({ id: doc.id, gmail: d.gmail || "", name: d.name || "" });
      teachers.push({ ...d, id: doc.id });
    });
    teachers.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return res.json({ teachers });
  } catch (err) {
    console.error("[TEACHER-POINTS] list teachers error:", err);
    return res.status(500).json({ error: "failed_to_list_teachers" });
  }
});

// ---------------------------------------------------------------------------
// Teacher management (admin) — list/search/filter, create, update, close.
// `isAccountActive` (default true) gates login; class assignment is mirrored to
// each class's `teacherId[]` (the source of truth used by the class screens).
// ---------------------------------------------------------------------------

/** Editable teacher fields (username/password and system fields are excluded). */
const TEACHER_EDITABLE_FIELDS = [
  "name",
  "gmail",
  "phone",
  "dob",
  "address",
  "notes",
];

/** Strips the password hash before returning a teacher record to the client. */
function publicTeacher(id, data, classIds, classNames) {
  const { password, ...rest } = data;
  return {
    id,
    ...rest,
    isAccountActive: data.isAccountActive !== false,
    classIds,
    classNames,
  };
}

/** Builds teacherId -> { classIds[], classNames[] } from all class docs. */
async function buildClassAssignments() {
  const classSnap = await db.collection("classes").get();
  const byTeacher = {}; // id -> classIds
  const names = {}; // id -> classNames
  classSnap.forEach((doc) => {
    const d = doc.data();
    const ids = Array.isArray(d.teacherId) ? d.teacherId : [];
    ids.forEach((tid) => {
      (byTeacher[tid] ||= []).push(doc.id);
      (names[tid] ||= []).push(d.name || doc.id);
    });
  });
  return { byTeacher, names };
}

/** Admin: list/search/filter teachers for the management screen. */
app.get(
  "/teachers/manage",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const [snap, assignments] = await Promise.all([
        db.collection("teachers").get(),
        buildClassAssignments(),
      ]);
      const teachers = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const filtered = teacherFilter.filterTeachers(
        teachers,
        {
          q: req.query.q,
          classId: req.query.classId,
          isAccountActive: req.query.isAccountActive,
        },
        assignments.byTeacher,
      );
      const records = filtered.map((t) =>
        publicTeacher(
          t.id,
          t,
          assignments.byTeacher[t.id] || [],
          assignments.names[t.id] || [],
        ),
      );
      return res.json({ teachers: records });
    } catch (err) {
      console.error("[TEACHERS] list error:", err);
      return res.status(500).json({ error: "failed_to_list_teachers" });
    }
  },
);

/** Adds/removes a teacherId on each class's `teacherId[]` to match a new assignment. */
async function syncClassAssignment(teacherId, oldIds, newIds) {
  const { added, removed } = teacherFilter.diffClassIds(oldIds, newIds);
  const ops = [];
  added.forEach((cid) =>
    ops.push(
      db
        .collection("classes")
        .doc(cid)
        .update({
          teacherId: admin.firestore.FieldValue.arrayUnion(teacherId),
        }),
    ),
  );
  removed.forEach((cid) =>
    ops.push(
      db
        .collection("classes")
        .doc(cid)
        .update({
          teacherId: admin.firestore.FieldValue.arrayRemove(teacherId),
        }),
    ),
  );
  await Promise.all(ops);
}

/** Admin: create a teacher (requires username + password, like signup). */
app.post("/teachers", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const {
      name,
      phone,
      dob,
      address = "",
      notes = "",
      username,
      password,
    } = req.body;
    const gmail = String(req.body.gmail || "")
      .trim()
      .toLowerCase();
    const classIds = Array.isArray(req.body.classIds) ? req.body.classIds : [];

    if (!name || !phone || !dob || !gmail) {
      return res.status(400).json({ error: "missing_required_fields" });
    }
    if (!username || !password) {
      return res.status(400).json({ error: "username_password_required" });
    }

    const teachersRef = db.collection("teachers");
    if (!(await teachersRef.where("gmail", "==", gmail).limit(1).get()).empty) {
      return res.status(409).json({ error: "gmail_exists" });
    }
    if (
      !(await teachersRef.where("username", "==", username).limit(1).get())
        .empty
    ) {
      return res.status(409).json({ error: "username_exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const teacherData = {
      gmail,
      name,
      phone,
      dob,
      address,
      notes,
      username,
      password: hashedPassword,
      classIds,
      isAccountActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const docRef = await teachersRef.add(teacherData);
    await syncClassAssignment(docRef.id, [], classIds);

    return res
      .status(201)
      .json(publicTeacher(docRef.id, teacherData, classIds, []));
  } catch (err) {
    console.error("[TEACHERS] create error:", err);
    return res.status(500).json({ error: "failed_to_create_teacher" });
  }
});

/** Admin: update a teacher. Never touches username/password. */
app.patch(
  "/teachers/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const ref = db.collection("teachers").doc(req.params.id);
      const snap = await ref.get();
      if (!snap.exists) {
        return res.status(404).json({ error: "teacher_not_found" });
      }
      const current = snap.data();
      const updates = {};

      for (const field of TEACHER_EDITABLE_FIELDS) {
        if (req.body[field] === undefined) continue;
        if (field === "gmail") {
          const gmail = String(req.body.gmail).trim().toLowerCase();
          if (!gmail) return res.status(400).json({ error: "gmail_required" });
          if (gmail !== current.gmail) {
            const dup = await db
              .collection("teachers")
              .where("gmail", "==", gmail)
              .limit(1)
              .get();
            if (!dup.empty && dup.docs[0].id !== req.params.id) {
              return res.status(409).json({ error: "gmail_exists" });
            }
          }
          updates.gmail = gmail;
        } else {
          updates[field] = req.body[field];
        }
      }

      if (typeof req.body.isAccountActive === "boolean") {
        updates.isAccountActive = req.body.isAccountActive;
      }

      let newClassIds = Array.isArray(current.classIds) ? current.classIds : [];
      if (Array.isArray(req.body.classIds)) {
        newClassIds = req.body.classIds;
        updates.classIds = newClassIds;
        await syncClassAssignment(
          req.params.id,
          current.classIds || [],
          newClassIds,
        );
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "nothing_to_update" });
      }

      await ref.update(updates);

      // Keep the TeacherPoint record's denormalized name/gmail in sync. Best-effort:
      // a failure here must not fail the teacher update (teachers is the source of truth).
      const pointUpdates = {};
      if (updates.name !== undefined) pointUpdates.name = updates.name;
      if (updates.gmail !== undefined) pointUpdates.gmail = updates.gmail;
      if (Object.keys(pointUpdates).length > 0) {
        try {
          const pointRef = db.collection("TeacherPoint").doc(req.params.id);
          const pointSnap = await pointRef.get();
          // Only update an existing record — never create a partial one (records are lazy).
          if (pointSnap.exists) {
            await pointRef.update(pointUpdates);
          }
        } catch (syncErr) {
          console.error("[TEACHERS] point sync error:", syncErr);
        }
      }

      return res.json(
        publicTeacher(
          req.params.id,
          { ...current, ...updates },
          newClassIds,
          [],
        ),
      );
    } catch (err) {
      console.error("[TEACHERS] update error:", err);
      return res.status(500).json({ error: "failed_to_update_teacher" });
    }
  },
);

/**
 * Admin: permanently delete a teacher account. Irreversible.
 *
 * Always removes the TeacherPoint record. For each class referencing the teacher:
 *  - if `deleteClasses` is set AND the teacher is the SOLE owner (teacherId === [id]),
 *    the class is deleted (and, when `deleteStudents` is set, its students too);
 *  - otherwise the teacher is just unlinked (arrayRemove) — shared classes are never
 *    deleted, so other teachers on them are unaffected.
 */
app.delete(
  "/teachers/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const teacherId = req.params.id;
      const { deleteClasses = false, deleteStudents = false } = req.body || {};
      const ref = db.collection("teachers").doc(teacherId);
      if (!(await ref.get()).exists) {
        return res.status(404).json({ error: "teacher_not_found" });
      }

      const classSnap = await db
        .collection("classes")
        .where("teacherId", "array-contains", teacherId)
        .get();

      const classRefsToDelete = []; // sole-owned classes to remove
      const classIdsToDelete = [];
      const classRefsToUnlink = []; // shared classes (or when not deleting classes)
      classSnap.docs.forEach((d) => {
        const ids = d.data().teacherId;
        const soleOwner = Array.isArray(ids) && ids.length === 1;
        if (deleteClasses && soleOwner) {
          classRefsToDelete.push(d.ref);
          classIdsToDelete.push(d.id);
        } else {
          classRefsToUnlink.push(d.ref);
        }
      });

      // Collect student docs of the to-be-deleted classes (both real + test tables).
      const studentRefsToDelete = [];
      if (deleteStudents && classIdsToDelete.length) {
        for (const collName of ["students", "students-testing-table"]) {
          const coll = db.collection(collName);
          const snaps = await Promise.all(
            classIdsToDelete.map((cid) =>
              coll.where("classId", "==", cid).get(),
            ),
          );
          snaps.forEach((snap) =>
            snap.docs.forEach((doc) => studentRefsToDelete.push(doc.ref)),
          );
        }
      }

      // Unlink shared classes (kept) from this teacher.
      await Promise.all(
        classRefsToUnlink.map((r) =>
          r.update({
            teacherId: admin.firestore.FieldValue.arrayRemove(teacherId),
          }),
        ),
      );

      // Batch-delete classes + their students, then the points + teacher docs.
      const allDeletes = [
        ...studentRefsToDelete,
        ...classRefsToDelete,
        db.collection("TeacherPoint").doc(teacherId),
        ref,
      ];
      const CHUNK = 400; // Firestore batch limit is 500.
      for (let i = 0; i < allDeletes.length; i += CHUNK) {
        const batch = db.batch();
        allDeletes.slice(i, i + CHUNK).forEach((r) => batch.delete(r));
        await batch.commit();
      }

      return res.json({
        success: true,
        deletedClasses: classRefsToDelete.length,
        deletedStudents: studentRefsToDelete.length,
      });
    } catch (err) {
      console.error("[TEACHERS] delete error:", err);
      return res.status(500).json({ error: "failed_to_delete_teacher" });
    }
  },
);

/**
 * Admin: the billing summary. `totalTopUpVnd` is the lifetime REVENUE — the
 * field kept its name: every top-up adds amount × 6/7 to it (before VND it
 * added the 60.000đ per 100 points, the same share). `totalCommissionVnd` is
 * the saler's cut, shown for the admin's information only (the saler takes it
 * upfront — it does not reduce the admin's revenue).
 */
app.get(
  "/teacher-points/billing",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const snap = await db.collection("AdminBilling").doc("summary").get();
      const data = snap.exists ? snap.data() : {};
      const totalTopUpVnd = data.totalTopUpVnd ?? 0;
      return res.json({
        totalTopUpVnd,
        totalCommissionVnd: billing.salerCostVnd(totalTopUpVnd),
      });
    } catch (err) {
      console.error("[TEACHER-POINTS] billing error:", err);
      return res.status(500).json({ error: "failed_to_get_billing" });
    }
  },
);

/**
 * Admin: list point rows — ONE PER TEACHER, not one per TeacherPoint doc.
 * Every active teacher appears (point defaults to 0) even before a TeacherPoint
 * record exists; the record is created lazily on the first edit/top-up. Closed
 * accounts are skipped unless they still hold a point record (so balances are
 * never hidden). The TeacherPoint doc id === teacherId.
 */
app.get(
  "/teacher-points",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      // Teacher ids that own at least one ACTIVE class — used to flag each record
      // so the FE can default-filter to teachers with active classes.
      const [activeClassSnap, teacherSnap, pointSnap] = await Promise.all([
        db.collection("classes").where("isActive", "==", true).get(),
        db.collection("teachers").get(),
        db.collection("TeacherPoint").get(),
      ]);

      const activeTeacherIds = new Set();
      activeClassSnap.forEach((doc) => {
        const ids = doc.data().teacherId;
        if (Array.isArray(ids)) ids.forEach((id) => activeTeacherIds.add(id));
      });

      // Index existing point records by teacherId (doc id === teacherId).
      const pointByTeacher = new Map();
      pointSnap.forEach((doc) => {
        const d = doc.data();
        pointByTeacher.set(d.teacherId ?? doc.id, { docId: doc.id, ...d });
      });

      const buildRow = (id, teacherId, source, balanceVnd) => {
        const history = Array.isArray(source?.topUpHistory)
          ? source.topUpHistory
          : [];
        // Before VND an entry recorded the points bought (amountVnd was the
        // 60.000đ revenue per 100 points); since, the credit and the revenue.
        const mappedHistory = history.map((h) => ({
          amountVnd: h.amountVnd ?? 0,
          creditVnd:
            h.creditVnd ??
            Math.round((h.points ?? 0) * billing.LEGACY_VND_PER_POINT),
          revenueVnd: h.revenueVnd ?? h.amountVnd ?? 0,
          points: h.points ?? null,
          topUpAt: h.topUpAt?.toDate?.().toISOString() ?? null,
        }));
        return {
          id,
          teacherId,
          gmail: source?.gmail ?? "",
          name: source?.name ?? "",
          balanceVnd,
          topUpCount: mappedHistory.length,
          lastTopUpAt: mappedHistory.length
            ? mappedHistory[mappedHistory.length - 1].topUpAt
            : null,
          topUpHistory: mappedHistory,
          hasActiveClass: activeTeacherIds.has(teacherId),
        };
      };

      const records = [];
      const seen = new Set();

      // One row per teacher: active accounts, or closed accounts that still hold
      // a point record (so their balance stays visible).
      teacherSnap.forEach((doc) => {
        const t = doc.data();
        const pd = pointByTeacher.get(doc.id);
        if (t.isAccountActive === false && !pd) return;
        // Prefer the teacher's current name/gmail; fall back to the point record.
        const source = {
          ...pd,
          gmail: t.gmail ?? pd?.gmail,
          name: t.name ?? pd?.name,
        };
        records.push(
          buildRow(
            pd?.docId ?? doc.id,
            doc.id,
            source,
            billing.balanceVndOf(pd),
          ),
        );
        seen.add(doc.id);
      });

      // Orphan point records whose teacher doc was deleted — keep them visible.
      pointSnap.forEach((doc) => {
        const d = doc.data();
        const teacherId = d.teacherId ?? doc.id;
        if (seen.has(teacherId)) return;
        records.push(buildRow(doc.id, teacherId, d, billing.balanceVndOf(d)));
      });

      records.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return res.json({ records });
    } catch (err) {
      console.error("[TEACHER-POINTS] list error:", err);
      return res.status(500).json({ error: "failed_to_list" });
    }
  },
);

/** Admin: create a TeacherPoint record for a teacher (id = teacherId). */
app.post(
  "/teacher-points",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const teacherId = req.body.teacherId;
      const balanceVnd = Math.round(Number(req.body.balanceVnd) || 0);
      if (!teacherId) {
        return res.status(400).json({ error: "teacherId_required" });
      }
      const teacherDoc = await db.collection("teachers").doc(teacherId).get();
      if (!teacherDoc.exists) {
        return res.status(404).json({ error: "teacher_not_found" });
      }
      const ref = db.collection("TeacherPoint").doc(teacherId);
      if ((await ref.get()).exists) {
        return res.status(409).json({ error: "already_exists" });
      }
      const teacher = teacherDoc.data();
      const data = {
        teacherId,
        gmail: teacher.gmail || "",
        name: teacher.name || "",
        balanceVnd,
        topUpHistory: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      await ref.set(data);
      return res.status(201).json({ id: teacherId, ...data });
    } catch (err) {
      console.error("[TEACHER-POINTS] create error:", err);
      return res.status(500).json({ error: "failed_to_create" });
    }
  },
);

/** Admin: set a teacher's balance (VND) directly (lazy-creates the record). */
app.patch(
  "/teacher-points/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      if (
        req.body.balanceVnd === null ||
        req.body.balanceVnd === undefined ||
        req.body.balanceVnd === "" ||
        !Number.isInteger(Number(req.body.balanceVnd)) ||
        Number(req.body.balanceVnd) < 0
      ) {
        return res.status(400).json({ error: "invalid_balance" });
      }
      const balanceVnd = Number(req.body.balanceVnd);
      const ref = db.collection("TeacherPoint").doc(req.params.id);
      if ((await ref.get()).exists) {
        await ref.update({
          balanceVnd,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // No record yet — create one (id === teacherId), copying name/gmail.
        const teacherDoc = await db
          .collection("teachers")
          .doc(req.params.id)
          .get();
        if (!teacherDoc.exists) {
          return res.status(404).json({ error: "not_found" });
        }
        const teacher = teacherDoc.data();
        await ref.set({
          teacherId: req.params.id,
          gmail: teacher.gmail || "",
          name: teacher.name || "",
          balanceVnd,
          topUpHistory: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return res.json({ id: req.params.id, balanceVnd });
    } catch (err) {
      console.error("[TEACHER-POINTS] update error:", err);
      return res.status(500).json({ error: "failed_to_update" });
    }
  },
);

/** Admin: delete a TeacherPoint record. */
app.delete(
  "/teacher-points/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const ref = db.collection("TeacherPoint").doc(req.params.id);
      if (!(await ref.get()).exists) {
        return res.status(404).json({ error: "not_found" });
      }
      await ref.delete();
      return res.json({ success: true });
    } catch (err) {
      console.error("[TEACHER-POINTS] delete error:", err);
      return res.status(500).json({ error: "failed_to_delete" });
    }
  },
);

/**
 * Admin: top up a teacher's balance. The amount (a multiple of 70.000đ) is
 * credited as is; amount × 6/7 is added to the admin's revenue (the saler
 * keeps the rest). Balance, history and revenue move in one transaction.
 */
app.post(
  "/teacher-points/:id/topup",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const amountVnd = Number(req.body.amountVnd);
      if (!billing.isValidTopUp(amountVnd)) {
        return res.status(400).json({ error: "invalid_amount" });
      }
      const ref = db.collection("TeacherPoint").doc(req.params.id);
      const teacherRef = db.collection("teachers").doc(req.params.id);
      const summaryRef = db.collection("AdminBilling").doc("summary");
      const revenueVnd = billing.revenueOfTopUp(amountVnd);

      const balanceVnd = await db.runTransaction(async (tx) => {
        const [pointSnap, teacherSnap] = await tx.getAll(ref, teacherRef);
        if (!pointSnap.exists && !teacherSnap.exists) return null;
        // A record from before VND only has `point`: converted here (× 700).
        const next = billing.balanceVndOf(pointSnap.data()) + amountVnd;
        const entry = {
          amountVnd,
          creditVnd: amountVnd,
          revenueVnd,
          topUpAt: admin.firestore.Timestamp.now(),
        };
        if (pointSnap.exists) {
          tx.update(ref, {
            balanceVnd: next,
            topUpHistory: admin.firestore.FieldValue.arrayUnion(entry),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          // No record yet — create one (id === teacherId).
          const teacher = teacherSnap.data();
          tx.set(ref, {
            teacherId: req.params.id,
            gmail: teacher.gmail || "",
            name: teacher.name || "",
            balanceVnd: next,
            topUpHistory: [entry],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        // Lazy-creates the singleton.
        tx.set(
          summaryRef,
          {
            totalTopUpVnd: admin.firestore.FieldValue.increment(revenueVnd),
            totalDepositVnd: admin.firestore.FieldValue.increment(amountVnd),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return next;
      });
      if (balanceVnd === null) {
        return res.status(404).json({ error: "not_found" });
      }
      res.locals.auditDetail =
        `Nạp ${billing.formatVnd(amountVnd)} · doanh thu ` +
        `+${billing.formatVnd(revenueVnd)} · số dư ${billing.formatVnd(balanceVnd)}`;
      return res.json({
        id: req.params.id,
        balanceVnd,
        addedVnd: amountVnd,
        revenueVnd,
      });
    } catch (err) {
      console.error("[TEACHER-POINTS] topup error:", err);
      return res.status(500).json({ error: "failed_to_topup" });
    }
  },
);

/**
 * 1. Endpoint đổi 'code' lấy Access Token & Refresh Token (Lúc mới Login)
 */
app.post("/auth/google", async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    // tokens sẽ chứa: access_token, refresh_token, expiry_date...
    tokens.refresh_token_expires_date =
      Date.now() + tokens.refresh_token_expires_in * 1000;

    // Attach the signed-in user's email + full name so the website's teacher
    // signup screen can pre-fill them (Gmail read-only, name editable). They
    // live in the OpenID id_token (scopes openid/email/profile). Best-effort:
    // login must still succeed even if extraction fails.
    try {
      if (tokens.id_token) {
        let payload;
        try {
          const ticket = await oAuth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: CLIENT_ID,
          });
          payload = ticket.getPayload();
        } catch {
          // The id_token came straight from Google's token endpoint, so fall
          // back to decoding its payload without re-verifying the signature.
          payload = JSON.parse(
            Buffer.from(tokens.id_token.split(".")[1], "base64").toString(),
          );
        }
        tokens.email = payload?.email || "";
      }
    } catch (profileErr) {
      console.warn(
        "Could not extract profile from id_token:",
        profileErr.message,
      );
    }

    // Keep the refresh token so grading jobs can write docs as this teacher
    // after the tab is closed. Never throws; a non-teacher is simply skipped.
    if (tokens.email && tokens.refresh_token) {
      await googleUserTokens.saveRefreshToken(
        tokens.email,
        tokens.refresh_token,
      );
    }

    res.json(tokens);
  } catch (error) {
    // Only the description: the error object carries the request body.
    console.error("Error exchanging code:", describeGoogleError(error));
    res.status(500).json({ error: "Failed to exchange code" });
  }
});

/**
 * Login with username and password
 */
app.post("/auth/username-password", async (req, res) => {
  const secret_key = req.headers["x-api-key"];
  if (secret_key !== EXTENSION_SECRET_KEY) {
    return res.status(401).json({ error: "Invalid key" });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "username and password are required" });
  }

  try {
    // Query Firestore for teacher with matching username
    const teachersRef = db.collection("teachers");
    const snapshot = await teachersRef
      .where("username", "==", username)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const teacherDoc = snapshot.docs[0];
    const teacherData = teacherDoc.data();

    // Verify password using bcrypt
    if (!teacherData.password) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      teacherData.password,
    );
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Closed accounts cannot log in.
    if (teacherData.isAccountActive === false) {
      return res.status(403).json({ error: "account_closed" });
    }

    // Generate JWT tokens
    const access_token = jwt.sign(
      {
        id: teacherDoc.id,
        email: teacherData.gmail,
        username: teacherData.username,
      },
      JWT_SECRET,
      { expiresIn: "1h" },
    );

    const refresh_token = jwt.sign(
      {
        id: teacherDoc.id,
        email: teacherData.gmail,
        username: teacherData.username,
        type: "refresh",
      },
      JWT_SECRET,
      { expiresIn: "30d" },
    );

    const expires_in = 3600; // 1 hour in seconds
    const refresh_token_expires_date = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

    // Mint a REAL Google access token (service account) so the client can call
    // the Google Docs API. `access_token` (JWT) authenticates THIS backend only.
    let google_access_token = null;
    try {
      google_access_token = await getServiceAccountGoogleToken();
    } catch (tokenError) {
      console.error("Failed to mint Google access token:", tokenError.message);
    }

    res.json({
      access_token,
      expires_in,
      refresh_token,
      refresh_token_expires_date,
      google_access_token,
    });
  } catch (error) {
    console.error("Error in username/password login:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * Mint a fresh Google access token (service account) for Google Docs API calls.
 * Protected by the backend JWT/Google token. Call this when the previous
 * google_access_token expires (~1h).
 */
app.get("/auth/google-token", verifyToken, async (req, res) => {
  try {
    const google_access_token = await getServiceAccountGoogleToken();
    res.json({ google_access_token, expires_in: 3600 });
  } catch (error) {
    console.error("Error minting Google access token:", error.message);
    res.status(500).json({ error: "Failed to mint Google access token" });
  }
});

/**
 * 2. Endpoint làm mới Access Token từ Refresh Token
 */
app.post("/auth/refresh", async (req, res) => {
  const refreshToken = req.body.refresh_token;

  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token is required" });
  }

  try {
    // First, try JWT refresh token
    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      if (decoded.type !== "refresh") {
        throw new Error("Invalid refresh token type");
      }

      // A closed account cannot refresh its session (so a close takes effect
      // within the 1h access-token lifetime).
      if (decoded.email) {
        const tSnap = await db
          .collection("teachers")
          .where("gmail", "==", String(decoded.email).toLowerCase())
          .limit(1)
          .get();
        if (!tSnap.empty && tSnap.docs[0].data().isAccountActive === false) {
          return res.status(403).json({ error: "account_closed" });
        }
      }

      // Generate new access token
      const access_token = jwt.sign(
        { id: decoded.id, email: decoded.email, username: decoded.username },
        JWT_SECRET,
        { expiresIn: "1h" },
      );

      // Also hand back a fresh Google token for the Docs API.
      let google_access_token = null;
      try {
        google_access_token = await getServiceAccountGoogleToken();
      } catch (tokenError) {
        console.error(
          "Failed to mint Google access token:",
          tokenError.message,
        );
      }

      return res.json({
        access_token,
        expiry_date: Date.now() + 3600 * 1000,
        refresh_token: refreshToken, // Keep the same refresh token
        refresh_token_expires_date: Date.now() + 30 * 24 * 60 * 60 * 1000,
        google_access_token,
      });
    } catch {
      // If JWT fails, try Google refresh token
    }

    // Handle Google refresh token (original logic)
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oAuth2Client.refreshAccessToken();

    // The website refreshes every open tab here, so this is also where a
    // teacher who logged in BEFORE grading jobs existed gets their token
    // stored — no fresh login needed. The id_token (openid scope) names them.
    try {
      const email = credentials.id_token
        ? (
            await oAuth2Client.verifyIdToken({
              idToken: credentials.id_token,
              audience: CLIENT_ID,
            })
          ).getPayload()?.email
        : null;
      if (email) {
        await googleUserTokens.saveRefreshToken(
          email,
          credentials.refresh_token || refreshToken,
        );
      }
    } catch (err) {
      console.warn("Could not store Google refresh token:", err.message);
    }

    res.json({
      access_token: credentials.access_token,
      expiry_date: credentials.expiry_date || 3600 * 1000 + Date.now(),
      refresh_token: credentials.refresh_token,
      refresh_token_expires_date:
        Date.now() + credentials.refresh_token_expires_in * 1000,
    });
  } catch (error) {
    // Only the description: the error object carries the refresh token.
    console.error("Error refreshing token:", describeGoogleError(error));
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/**
 * Get teacher info for the authenticated user
 */
app.get("/teacher-info", verifyGoogleToken, async (req, res) => {
  try {
    const userEmail = req.userEmail;
    const teachersRef = db.collection("teachers");
    const snapshot = await teachersRef
      .where("gmail", "==", userEmail)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(403).json({ error: "Teacher not found" });
    }

    const teacherDoc = snapshot.docs[0];
    // Never send the password hash to the browser.
    const { password, ...info } = teacherDoc.data();
    res.json({ id: teacherDoc.id, ...info });
  } catch (error) {
    console.error("Error fetching teacher info:", error);
    res.status(500).json({ error: "Failed to fetch teacher info" });
  }
});

/**
 * Saves the signed-in teacher's own UI preferences (light/dark theme), so they
 * follow the account to another device. Only the keys sent are written; GET
 * /teacher-info returns them back as `preferences`.
 */
app.patch("/teacher-info/preferences", verifyGoogleToken, async (req, res) => {
  const { preferences, error } = teacherPreferences.parsePreferences(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const snapshot = await db
      .collection("teachers")
      .where("gmail", "==", req.userEmail)
      .limit(1)
      .get();
    if (snapshot.empty) {
      return res.status(403).json({ error: "Teacher not found" });
    }
    const teacherDoc = snapshot.docs[0];
    await teacherDoc.ref.update(
      teacherPreferences.toFirestoreUpdate(preferences),
    );
    res.json({
      preferences: { ...(teacherDoc.data().preferences || {}), ...preferences },
    });
  } catch (err) {
    console.error("Error saving teacher preferences:", err);
    res.status(500).json({ error: "Failed to save preferences" });
  }
});

app.post("/teacher-signup", async (req, res) => {
  try {
    const {
      name,
      phone,
      dob,
      address = "",
      notes = "",
      username,
      password,
      gmail,
    } = req.body;
    const userEmail = gmail?.trim().toLowerCase();

    if (!name || !phone || !dob) {
      return res
        .status(400)
        .json({ error: "Missing required fields: name, phone, dob" });
    }

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Missing required fields: username, password" });
    }

    const teachersRef = db.collection("teachers");
    // Check if teacher with this email already exists
    const existingEmailSnapshot = await teachersRef
      .where("gmail", "==", userEmail)
      .limit(1)
      .get();
    if (!existingEmailSnapshot.empty) {
      return res.status(409).json({ error: "Teacher already exists" });
    }
    // Check if username already exists
    const existingUsernameSnapshot = await teachersRef
      .where("username", "==", username)
      .limit(1)
      .get();
    if (!existingUsernameSnapshot.empty) {
      return res.status(409).json({ error: "Username already exists" });
    }
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    const teacherData = {
      gmail: userEmail,
      name,
      phone,
      dob,
      address,
      notes,
      username,
      password: hashedPassword,
      classIds: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const newDocRef = await teachersRef.add(teacherData);
    // Return response without the password hash
    const responseData = { ...teacherData };
    delete responseData.password;
    res.status(201).json({ id: newDocRef.id, ...responseData });
  } catch (error) {
    console.error("Error creating teacher:", error);
    res.status(500).json({ error: "Failed to create teacher record" });
  }
});

app.post("/classes", verifyGoogleToken, async (req, res) => {
  try {
    const {
      name,
      classType = "basic",
      courseId = null,
      currentLesson = null,
      teacherId,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Missing required field: name" });
    }

    // A class follows a course (lib/courses.js). A request without courseId
    // is the pre-course website — it still sends the old template code as
    // classType, stored as before.
    let placement = { classType };
    if (courseId) {
      try {
        const course = await courses.resolveForClass({
          courseId,
          currentLesson,
        });
        placement = { courseId: course.id };
        // The doc template the teacher picked among the course's.
        if (req.body.classType) {
          const template = await courses.resolveTemplate(
            req.body.classType,
            course,
          );
          placement.classType = template.code;
        }
      } catch (error) {
        if (error instanceof CourseError) {
          return res.status(error.status).json({ error: error.code });
        }
        throw error;
      }
    }

    // const teacherSnapshot = await db.collection('teachers')
    //   .where('gmail', '==', userEmail)
    //   .limit(1)
    //   .get();

    // if (teacherSnapshot.empty) {
    //   return res.status(403).json({ error: 'Teacher account not found' });
    // }

    // const teacherId = teacherSnapshot.docs[0].id;
    // const duplicateClassSnapshot = await db.collection('classes')
    //   .where('name', '==', name)
    //   .where('teacherId', 'array-contains', teacherId)
    //   .limit(1)
    //   .get();
    const isDuplicated = await isClassNameDuplicated(name);

    if (isDuplicated) {
      return res
        .status(409)
        .json({ error: "Class name already exists for this teacher" });
    }

    const classData = {
      name,
      ...placement,
      currentLesson: currentLesson || null,
      teacherId: [teacherId],
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const classRef = await db.collection("classes").add(classData);
    res.status(201).json({ id: classRef.id, ...classData });
  } catch (error) {
    console.error("Error creating class:", error);
    res.status(500).json({ error: "Failed to create class" });
  }
});

app.get("/classes/check-name", verifyGoogleToken, async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: "Class name is required" });
    }
    const isDuplicated = await isClassNameDuplicated(name);
    res.json({ exists: isDuplicated });
  } catch (error) {
    console.error("Error checking class name:", error);
    res.status(500).json({ error: "Failed to verify class name" });
  }
});

app.post("/students", verifyGoogleToken, async (req, res) => {
  try {
    const { classId, students } = req.body;

    if (!classId || !Array.isArray(students) || students.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing required fields: classId, students" });
    }
    const batch = db.batch();
    const studentsToSave = students
      .map((student) => ({
        classId: classId,
        gmail: student.gmail?.trim() || "",
        name: student.name?.trim(),
        ggDocLink: student.ggDocLink?.trim() || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }))
      // Gmail is temporarily optional; only require a name.
      .filter((student) => student.name);

    // One Google Doc belongs to exactly one student, so refuse the whole batch
    // when a doc id is already taken in this class or repeated in the payload.
    // The UI checks this too; this is the guard against a double submit or a
    // co-teacher adding the same student at the same time.
    const existingSnapshot = await db
      .collection("students")
      .where("classId", "==", classId)
      .get();
    const existingStudents = existingSnapshot.docs.map((doc) => doc.data());
    const duplicates = findDuplicateDocs(studentsToSave, existingStudents);
    if (duplicates.length > 0) {
      return res.status(409).json({ error: "duplicate_doc", duplicates });
    }

    studentsToSave.forEach((student) => {
      const docRef = db.collection("students").doc();
      batch.set(docRef, {
        ...student,
      });
    });

    await batch.commit();
    res.status(201).json({ inserted: studentsToSave.length });
  } catch (error) {
    console.error("Error saving students:", error);
    res.status(500).json({ error: "Failed to save students" });
  }
});

/**
 * Remove several students from their class at once. A student belongs to a class
 * through their own `classId` field, so removing them from the class means
 * deleting the student document.
 *
 * Declared before DELETE /students/:id so "bulk-delete" is never read as an id.
 */
app.post("/students/bulk-delete", verifyGoogleToken, async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids is required" });
    }

    const refs = ids.map((id) => db.collection("students").doc(String(id)));
    const CHUNK = 400; // Firestore batch limit is 500.
    for (let i = 0; i < refs.length; i += CHUNK) {
      const batch = db.batch();
      refs.slice(i, i + CHUNK).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }

    res.json({ success: true, deleted: refs.length });
  } catch (error) {
    console.error("Error deleting students:", error);
    res.status(500).json({ error: "Failed to delete students" });
  }
});

/** Remove one student from their class (deletes the student document). */
app.delete("/students/:id", verifyGoogleToken, async (req, res) => {
  try {
    const ref = db.collection("students").doc(req.params.id);
    if (!(await ref.get()).exists) {
      return res.status(404).json({ error: "student_not_found" });
    }
    await ref.delete();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting student:", error);
    res.status(500).json({ error: "Failed to delete student" });
  }
});

/**
 * Get classes for the authenticated user
 */
app.get("/classes", verifyGoogleToken, async (req, res) => {
  try {
    const teacherId = req.query.teacherId;
    if (!teacherId) {
      return res.status(400).json({ error: "teacherId is required" });
    }
    const classesRef = db.collection("classes");
    const snapshot = await classesRef
      .where("teacherId", "array-contains", teacherId)
      .get();
    if (snapshot.empty) {
      return res.json([]);
    }
    const classes = [];
    snapshot.forEach((doc) => {
      const d = doc.data();
      // A Timestamp would serialize as {_seconds, _nanoseconds}; send ISO
      // like /classes/all does.
      classes.push({
        id: doc.id,
        ...d,
        createdAt: d.createdAt?.toDate?.().toISOString() ?? null,
      });
    });

    res.json(classes);
  } catch (error) {
    console.error("Error fetching classes:", error);
    res.status(500).json({ error: "Failed to fetch classes" });
  }
});

/**
 * Get lessons for the authenticated user and selected class
 */
app.get("/class-types", verifyGoogleToken, async (req, res) => {
  try {
    // Each template with the grading profile it belongs to, so a class
    // form offers only its course's templates.
    res.json(await courses.templates());
  } catch (error) {
    console.error("Error fetching class types:", error);
    res.status(500).json({ error: "Failed to fetch class types" });
  }
});

// Doc templates (`classType`), managed by admins (lib/courses.js).

/** The templates with how many classes and lessons use each. */
app.get(
  "/class-types/usage",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      res.json({ templates: await courses.templatesWithUsage() });
    } catch (error) {
      sendCourseError(res, error, "Error listing template usage:");
    }
  },
);

app.post("/class-types", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const template = await courses.createTemplate(req.body);
    res.locals.auditDetail = `Tạo template ${template.name} (${template.code}, ${template.gradingProfile})`;
    res.status(201).json({ template });
  } catch (error) {
    sendCourseError(res, error, "Error creating template:");
  }
});

app.patch(
  "/class-types/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const template = await courses.updateTemplate(req.params.id, req.body);
      const changed = Object.keys(req.body || {}).join(", ");
      res.locals.auditDetail = `Sửa template ${template.code}: ${changed}`;
      res.json({ template });
    } catch (error) {
      sendCourseError(res, error, "Error updating template:");
    }
  },
);

app.delete(
  "/class-types/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const template = await courses.deleteTemplate(req.params.id);
      res.locals.auditDetail = `Xóa template ${template.name} (${template.code})`;
      res.json({ template });
    } catch (error) {
      sendCourseError(res, error, "Error deleting template:");
    }
  },
);

// ---------------------------------------------------------------------------
// Courses (lib/courses.js): a class is Basic or IELTS and follows one course.
// Teachers read them; only admins create or edit them.
// ---------------------------------------------------------------------------

function sendCourseError(res, error, fallback) {
  if (error instanceof CourseError) {
    return res
      .status(error.status)
      .json({ error: error.code, ...(error.params || {}) });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: "course_failed" });
}

/** ?includeInactive=1 also lists the hidden courses. */
app.get("/courses", verifyGoogleToken, async (req, res) => {
  try {
    const list = await courses.list({
      includeInactive: req.query.includeInactive === "1",
    });
    res.json({ courses: list });
  } catch (error) {
    sendCourseError(res, error, "Error listing courses:");
  }
});

app.post("/courses", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const course = await courses.create(req.body);
    res.locals.auditDetail = `Tạo khóa ${course.name} (${course.lessonIds.length} buổi)`;
    res.status(201).json({ course });
  } catch (error) {
    sendCourseError(res, error, "Error creating course:");
  }
});

app.patch("/courses/:id", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const course = await courses.update(req.params.id, req.body);
    const changed = Object.keys(req.body || {}).join(", ");
    res.locals.auditDetail = `Sửa khóa ${course.name}: ${changed}`;
    res.json({ course });
  } catch (error) {
    sendCourseError(res, error, "Error updating course:");
  }
});

/**
 * Lessons, in course order:
 *   ?classId=   the class's lessons (its course's; legacy classes: template)
 *   ?courseId=  one course's lessons (the new-class form)
 *   ?classType= legacy template lookup (the pre-course website)
 *   (none)      every lesson — the admin's picker when editing a course
 */
app.get("/lessons", verifyGoogleToken, async (req, res) => {
  try {
    const { classId, courseId, classType } = req.query;

    if (classId) {
      if (String(classId).includes("/")) {
        return res.status(404).json({ error: "Class not found" });
      }
      const classSnap = await db
        .collection("classes")
        .doc(String(classId))
        .get();
      if (!classSnap.exists) {
        return res.status(404).json({ error: "Class not found" });
      }
      return res.json(await courses.lessonsForClass(classSnap.data()));
    }
    if (courseId) return res.json(await courses.lessonsForCourse(courseId));
    if (classType) {
      return res.json(await courses.lessonsForClass({ classType }));
    }
    res.json(await courses.allLessons());
  } catch (error) {
    console.error("Error fetching lessons:", error);
    res.status(500).json({ error: "Failed to fetch lessons" });
  }
});

/**
 * Get current lesson for the selected class
 */
app.get("/current-lesson", verifyGoogleToken, async (req, res) => {
  try {
    const classId = req.query.classId;
    if (!classId) {
      return res.status(400).json({ error: "classId is required" });
    }

    const classRef = db.collection("classes").doc(classId);
    const classDoc = await classRef.get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: "Class not found" });
    }

    const classData = classDoc.data();
    const currentLesson = classData?.currentLesson || null;
    res.json({ currentLesson });
  } catch (error) {
    console.error("Error fetching current lesson:", error);
    res.status(500).json({ error: "Failed to fetch current lesson" });
  }
});

app.patch("/classes/current-lesson", verifyGoogleToken, async (req, res) => {
  try {
    const { classId, currentLesson } = req.body;
    if (!classId || !currentLesson) {
      return res
        .status(400)
        .json({ error: "classId and currentLesson are required" });
    }

    const classRef = db.collection("classes").doc(classId);
    // The lesson doc is read only for the audit line; both ids are already
    // guarded non-empty above, so neither .doc() call can throw on "".
    const [classDoc, lessonSnap] = await Promise.all([
      classRef.get(),
      db.collection("lesson").doc(String(currentLesson)).get(),
    ]);
    if (!classDoc.exists) {
      return res.status(404).json({ error: "Class not found" });
    }

    await classRef.update({ currentLesson });
    // Without this the middleware falls back to summarizeBody(), which dumps
    // opaque Firestore ids — unreadable in the audit log. Lesson names already
    // start with "BUỔI", so no extra "buổi" word here.
    res.locals.auditDetail =
      `Đổi thành ${lessonSnap.data()?.name || currentLesson} ` +
      `cho lớp ${classDoc.data()?.name || classId}`;
    res.json({ success: true, currentLesson });
  } catch (error) {
    console.error("Error updating current lesson:", error);
    res.status(500).json({ error: "Failed to update current lesson" });
  }
});

/**
 * Admin: list ALL classes (every teacher) with teacher names joined. Used by the
 * class-management screen when an admin is logged in. Missing `isActive` is
 * treated as active so pre-migration docs still show up as active.
 *
 * Only active classes by default (every class picker uses this);
 * ?includeInactive=1 adds the closed ones, for the class-management filter.
 */
app.get("/classes/all", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === "1";
    const classesRef = db.collection("classes");
    const [classSnap, teacherSnap] = await Promise.all([
      (includeInactive
        ? classesRef
        : classesRef.where("isActive", "==", true)
      ).get(),
      db.collection("teachers").get(),
    ]);
    const teacherNameById = new Map();
    const teacherGmailById = new Map();
    teacherSnap.forEach((doc) => {
      const d = doc.data();
      teacherNameById.set(doc.id, d.name || d.gmail || doc.id);
      if (d.gmail) teacherGmailById.set(doc.id, d.gmail);
    });
    const classes = [];
    classSnap.forEach((doc) => {
      const d = doc.data();
      const teacherIds = Array.isArray(d.teacherId) ? d.teacherId : [];
      classes.push({
        id: doc.id,
        name: d.name ?? "",
        classType: d.classType ?? "",
        courseId: d.courseId ?? null,
        currentLesson: d.currentLesson ?? null,
        isActive: d.isActive,
        // Classes created before createdAt was stored have none.
        createdAt: d.createdAt?.toDate?.().toISOString() ?? null,
        teacherId: teacherIds,
        teacherNames: teacherIds.map((id) => teacherNameById.get(id) || id),
        // For searching by teacher gmail; teachers without one are skipped.
        teacherEmails: teacherIds
          .map((id) => teacherGmailById.get(id))
          .filter(Boolean),
      });
    });
    res.json(classes);
  } catch (error) {
    console.error("Error fetching active classes:", error);
    res.status(500).json({ error: "Failed to fetch active classes" });
  }
});

/**
 * Update a class: rename (`name`) and/or deactivate (`isActive: false`).
 * Deactivation is irreversible by design — there is no re-activate path here.
 */
app.patch("/classes/:id", verifyGoogleToken, async (req, res) => {
  try {
    const classId = req.params.id;
    const { name, isActive } = req.body;

    const classRef = db.collection("classes").doc(classId);
    const classDoc = await classRef.get();
    if (!classDoc.exists) {
      return res.status(404).json({ error: "Class not found" });
    }

    const updates = {};

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ error: "Class name cannot be empty" });
      }
      if (await isClassNameDuplicated(trimmed, classId)) {
        return res.status(409).json({ error: "Class name already exists" });
      }
      updates.name = trimmed;
    }

    if (isActive === false) {
      updates.isActive = false;
    }

    // Moving the class to another course. The current lesson must exist in
    // the new course — the one sent along, or the class's own.
    if (req.body.courseId !== undefined) {
      const currentLesson =
        req.body.currentLesson || classDoc.data().currentLesson || null;
      try {
        const course = await courses.resolveForClass({
          courseId: req.body.courseId,
          currentLesson,
          keepCourseId: classDoc.data().courseId || null,
        });
        if (course.id !== classDoc.data().courseId)
          updates.courseId = course.id;
        if (req.body.currentLesson) updates.currentLesson = currentLesson;
      } catch (error) {
        if (error instanceof CourseError) {
          return res.status(error.status).json({ error: error.code });
        }
        throw error;
      }
    }

    // Another doc template: one of the templates of the class's course (the
    // new one when it moves). "" drops it — a course without templates.
    if (req.body.classType !== undefined) {
      const courseId = updates.courseId || classDoc.data().courseId;
      const course = courseId ? await courses.get(courseId) : null;
      if (!course) {
        return res.status(400).json({ error: "course_not_found" });
      }
      if (req.body.classType) {
        try {
          const template = await courses.resolveTemplate(
            req.body.classType,
            course,
          );
          if (template.code !== classDoc.data().classType)
            updates.classType = template.code;
        } catch (error) {
          if (error instanceof CourseError) {
            return res.status(error.status).json({ error: error.code });
          }
          throw error;
        }
      } else if (classDoc.data().classType) {
        updates.classType = admin.firestore.FieldValue.delete();
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await classRef.update(updates);
    res.json({
      success: true,
      ...updates,
      // A dropped template, not Firestore's delete marker.
      ...("classType" in updates && typeof updates.classType !== "string"
        ? { classType: null }
        : {}),
    });
  } catch (error) {
    console.error("Error updating class:", error);
    res.status(500).json({ error: "Failed to update class" });
  }
});

/**
 * Get  for the selected class
 */
app.get("/students", verifyGoogleToken, async (req, res) => {
  try {
    const classId = req.query.classId;

    if (!classId) {
      return res.status(400).json({ error: "classId is required" });
    }

    const studentsRef = db.collection("students");
    const snapshot = await studentsRef.where("classId", "==", classId).get();

    const students = [];
    snapshot.forEach((doc) => {
      students.push({ id: doc.id, ...doc.data() });
    });

    res.json(students);
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

// ---------------------------------------------------------------------------
// Background grading jobs (lib/gradingJobs.js)
//
// The website starts a job and may close the tab: reading the docs, grading,
// writing feedback, charging and notifying all happen here, step by step,
// through Cloud Tasks.
// ---------------------------------------------------------------------------

/**
 * Encryption for stored Google refresh tokens. Without it nothing is stored,
 * so Google-login teachers get `google_reauth_required` when starting a job;
 * username/password teachers are unaffected (service account).
 */
const tokenCipher = (() => {
  const spec = process.env.GOOGLE_TOKEN_ENC_KEYS;
  if (!spec) {
    console.warn(
      "WARNING: GOOGLE_TOKEN_ENC_KEYS not set. Google-login teachers cannot " +
        "start grading jobs until it is.",
    );
    return null;
  }
  const keys = parseKeys(spec);
  return createTokenCipher({
    keys,
    current: process.env.GOOGLE_TOKEN_ENC_KEY_CURRENT || [...keys.keys()][0],
  });
})();

const googleUserTokens = createGoogleUserTokens({
  db,
  admin,
  cipher: tokenCipher,
  createOAuthClient: () =>
    new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI),
  getServiceAccountToken: getServiceAccountGoogleToken,
});

/**
 * Downloads one image of a Google Doc by its `contentUri` (a short-lived URL
 * the Docs API hands out with the document). It is normally readable as is;
 * when Google asks for credentials, the doc reader's own token is sent.
 */
async function fetchDocImage(uri, accessToken) {
  let response = await fetch(uri);
  if ((response.status === 401 || response.status === 403) && accessToken) {
    response = await fetch(uri, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }
  if (!response.ok) throw new Error(`image_http_${response.status}`);
  const mime = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return { mime, buffer: Buffer.from(await response.arrayBuffer()) };
}

/**
 * lib/doc/ is the website's own ES modules, copied verbatim (see
 * scripts/syncDocLib.js), so it is loaded with import() rather than require().
 */
let docLibPromise = null;
function loadDocLib() {
  docLibPromise ??= Promise.all([
    import("./lib/doc/docParser.js"),
    import("./lib/doc/docTableDetect.js"),
    import("./lib/doc/docWriter.js"),
    import("./lib/doc/ieltsDoc.js"),
    import("./lib/doc/hsDoc.js"),
  ]).then(([...modules]) => {
    // HS under its own key: merged, its exports would shadow the Basic
    // modules' (both export normalizeText).
    const hs = modules.pop();
    return Object.assign({}, ...modules, { hs });
  });
  return docLibPromise;
}

/** Title + body a finished job is announced with (bell and push alike). */
function describeJobOutcome(job) {
  const where = `Lớp ${job.className || "?"} · Buổi ${job.lessonName || "?"}`;
  const progress = `đã ghi ${job.written}/${job.total} bài`;
  if (job.reauthRequired || job.error === "google_reauth_required") {
    return {
      type: "grading.jobNeedsReauth",
      title: "Cần đăng nhập lại Google để chấm tiếp",
      body: `${where}: ${progress}. Đăng nhập lại bằng Google rồi bấm chấm lại.`,
    };
  }
  if (job.error === "not_enough_points") {
    return {
      type: "grading.jobFailed",
      title: "Chưa chấm được: không đủ số dư",
      body:
        `${where}: cần ${billing.formatVnd(job.errorParams?.needVnd)} ` +
        `(${job.errorParams?.need} bài), còn ` +
        `${billing.formatVnd(job.errorParams?.haveVnd)}.`,
    };
  }
  if (job.error) {
    return {
      type: "grading.jobFailed",
      title: "Chấm bài không thành công",
      body: `${where}: ${job.error}.`,
    };
  }
  return {
    type: "grading.jobDone",
    title: "Đã chấm xong",
    body:
      `${where}: ${progress}.` +
      (job.stopped ? " Dừng giữa chừng vì hết số dư." : ""),
  };
}

const jobNotificationId = (job) =>
  notifications.notificationId("grading.job", job.id, "final");

const gradingJobs = createGradingJobs({
  db,
  admin,
  docsApi: googleDocsApi,
  tokens: googleUserTokens,
  loadDocLib,
  gradeItems: gradeItemsCached,
  consumePoints: consumePointsForDocs,
  // IELTS classes (course gradingProfile "ielts") — see lib/gradingJobs.js.
  gradingProfileOfClass: async (classData) =>
    classData?.courseId
      ? gradingProfileOf(await courses.get(classData.courseId))
      : gradingProfileOf(null),
  gradeIelts: (input, options) => ieltsGrader.grade(input, options),
  fetchImage: fetchDocImage,
  ieltsEnabled: ieltsConfigured,
  // HS classes (course gradingProfile "hs") — see lib/hsGrading.js.
  gradeHs: (items, options) => hsGrader.grade(items, options),
  hsEnabled: hsConfigured,
  resolvePayer,
  enqueue: (name, payload, options) =>
    taskQueue.enqueue(name, payload, options),
  // A scheduled job's end is owned by gradingSchedules.onJobFinished; the
  // wrapper routes it there and skips the regular bell + push for it.
  onFinished: scheduleAwareOnFinished(
    {
      /** The run's one audit line — the job-side twin of /grading-summary. */
      async recordSummary(job) {
        const actor = await auditLog.resolveActor(db, job.createdByEmail);
        await auditLog.recordAudit(db, admin, {
          id: `grading-summary-${job.id}`,
          requestId: job.id,
          actorEmail: job.createdByEmail,
          actorName: actor.name,
          actorId: actor.id,
          actorResolvedFrom: "token",
          action: "grading.pointsSummary",
          resourceType: "points",
          severity: "INFO",
          method: "SYSTEM",
          path: "/system/grading-job",
          entityId: job.id,
          success: true,
          detail:
            `Tổng tiền bị trừ: ${billing.formatVnd(
              job.charged * billing.unitPriceOfJob(job),
            )} (${job.charged} bài) · Lớp: ${job.className || "?"} · ` +
            `Buổi: ${job.lessonName || "?"} · GV: ${job.payerName || "?"}`,
        });
        // A scheduled job tells the payer itself (gradingSchedules owns its end).
        if (job.origin?.type === "schedule") return;
        const [payerSnap, classSnap, lessonSnap] = await Promise.all([
          db.collection("teachers").doc(job.payerTeacherId).get(),
          db.collection("classes").doc(job.classId).get(),
          db.collection("lesson").doc(job.lessonId).get(),
        ]);
        await notifyTeacherGradedByAdmin({
          actorEmail: job.createdByEmail,
          payer: payerSnap.exists
            ? { id: payerSnap.id, ...payerSnap.data() }
            : null,
          classSnap,
          lessonSnap,
          classId: job.classId,
          lessonId: job.lessonId,
          totalPoints: job.charged,
          requestId: job.id,
        }).catch((err) =>
          console.error("[NOTIFY] graded-by-admin failed:", err.message),
        );
      },

      /** Bell entry for whoever started the job. Fixed id: a retry overwrites. */
      async notify(job) {
        const { type, title, body } = describeJobOutcome(job);
        await notifications.createNotification(db, admin, {
          id: jobNotificationId(job),
          type,
          severity: job.error ? "WARN" : "INFO",
          title,
          body,
          data: {
            jobId: job.id,
            classId: job.classId,
            lessonId: job.lessonId,
            className: job.className,
            lessonName: job.lessonName,
            written: job.written,
            total: job.total,
            error: job.error || null,
            ...(job.errorParams || {}),
          },
          recipients: [job.createdByEmail],
          sourceRequestId: job.id,
        });
      },

      async push(job) {
        const { type, title, body } = describeJobOutcome(job);
        const tokens = await pushDevices.listActiveTokens(db, [
          job.createdByEmail,
        ]);
        const id = jobNotificationId(job);
        const result = await pushDevices.sendPush(admin, db, {
          tokens,
          title,
          body,
          data: { type, notificationId: id },
          link: process.env.PUBLIC_WEB_URL || undefined,
        });
        await notifications.recordPushResult(db, admin, id, result);
      },
    },
    () => gradingSchedules,
  ),
});

/**
 * Cloud Tasks in production; in-process for local dev (TASKS_MODE=inline),
 * where nothing survives a restart. See lib/taskQueue.js.
 */
const TASKS_MODE =
  process.env.TASKS_MODE ||
  (process.env.NODE_ENV === "production" ? "cloud" : "inline");
const taskQueue =
  TASKS_MODE === "cloud"
    ? createCloudQueue({
        project: process.env.TASKS_PROJECT,
        location: process.env.TASKS_LOCATION,
        queue: process.env.TASKS_QUEUE,
        targetUrl: process.env.TASKS_TARGET_URL,
        invokerServiceAccount: process.env.TASKS_INVOKER_SA,
      })
    : createInlineQueue({
        handler: (payload) => handleQueuedTask(payload),
      });

/** One queue carries both grading-job steps and grading-schedule steps. */
function handleQueuedTask(payload) {
  return payload?.kind === "schedule"
    ? gradingSchedules.handleTask(payload)
    : gradingJobs.handleTask(payload);
}

function sendJobError(res, err, where) {
  if (err instanceof JobError) {
    return res.status(err.status).json({ error: err.code, ...err.params });
  }
  console.error(`[GRADING-JOB] ${where}:`, err.message);
  return res.status(500).json({ error: "grading_job_failed" });
}

/** Starts grading a lesson for a class; answers as soon as the job is queued. */
app.post("/grading-jobs", verifyGoogleToken, async (req, res) => {
  try {
    const { jobId } = await gradingJobs.createJob({
      email: req.userEmail,
      authKind: req.authKind,
      isAdmin: ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase()),
      classId: req.body.classId,
      lessonId: req.body.lessonId,
      docIds: req.body.docIds,
      useCache: req.body.useCache,
    });
    res.locals.auditDetail = `Job ${jobId} · lớp ${req.body.classId} · buổi ${req.body.lessonId}`;
    return res.status(202).json({ jobId });
  } catch (err) {
    return sendJobError(res, err, "create");
  }
});

// Before /grading-jobs/:id, which would otherwise capture "latest".
app.get("/grading-jobs/latest", verifyGoogleToken, async (req, res) => {
  try {
    const job = await gradingJobs.getLatestJob(
      req.query.classId,
      req.query.lessonId,
      {
        email: req.userEmail,
        isAdmin: ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase()),
      },
    );
    return res.json({ job });
  } catch (err) {
    return sendJobError(res, err, "latest");
  }
});

app.get("/grading-jobs/:id", verifyGoogleToken, async (req, res) => {
  try {
    const job = await gradingJobs.getJob(req.params.id, {
      email: req.userEmail,
      isAdmin: ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase()),
    });
    return res.json({ job });
  } catch (err) {
    return sendJobError(res, err, "get");
  }
});

/**
 * Only Cloud Tasks may call the task route: it signs each request with an
 * OIDC token for TASKS_INVOKER_SA. The service itself is public (the website
 * calls it), so this check is the whole of the route's protection.
 */
const taskTokenVerifier = new OAuth2Client();
/**
 * Cloud Scheduler signs its tick calls the same way (same invoker account),
 * with the tick route's own URL as audience.
 */
const SCHEDULE_TICK_URL =
  process.env.SCHEDULE_TICK_URL ||
  String(process.env.TASKS_TARGET_URL || "").replace(
    /\/internal\/tasks\/grading$/,
    "/internal/tasks/schedule-tick",
  );
const verifyTaskRequest = (req, res, next) =>
  verifyInternalCall(req, res, next, process.env.TASKS_TARGET_URL);
const verifyTickRequest = (req, res, next) =>
  verifyInternalCall(req, res, next, SCHEDULE_TICK_URL);

async function verifyInternalCall(req, res, next, audience) {
  if (taskQueue.mode !== "cloud") return res.status(404).end();
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).end();
  try {
    const ticket = await taskTokenVerifier.verifyIdToken({
      idToken: header.slice(7),
      audience,
    });
    const payload = ticket.getPayload();
    if (
      payload?.email !== process.env.TASKS_INVOKER_SA ||
      payload?.email_verified !== true
    ) {
      return res.status(403).end();
    }
    return next();
  } catch (err) {
    console.error("[GRADING-JOB] task auth rejected:", err.message);
    return res.status(401).end();
  }
}

/**
 * One step of a grading job. 2xx tells Cloud Tasks the step is done; anything
 * else makes it retry with backoff — which is exactly what a transient failure
 * (Google 5xx, a busy prepare lease) should get. Permanent failures are
 * recorded on the job and answered 2xx, so they are not retried.
 */
app.post("/internal/tasks/grading", verifyTaskRequest, async (req, res) => {
  try {
    await handleQueuedTask(req.body);
    return res.status(204).end();
  } catch (err) {
    if (err instanceof RetryLater) {
      return res.status(503).json({ retry: err.message });
    }
    console.error(
      `[GRADING-JOB] ${req.body?.step} ${req.body?.jobId} failed:`,
      err.message,
    );
    return res.status(500).json({ error: "task_failed" });
  }
});

// ---------------------------------------------------------------------------
// Scheduled grading (lib/gradingSchedules.js)
//
// A class's weekly schedule: remind the teacher ~30 minutes before, then grade
// its current lesson through the same grading job as the button. Cloud
// Scheduler drives it by calling /internal/tasks/schedule-tick every 5
// minutes (see DEPLOYMENT_GUIDE.md); locally an interval does.
// ---------------------------------------------------------------------------

/** Env overrides of the schedule's time rules — mostly for manual testing. */
function scheduleOptionsFromEnv() {
  const minutes = (name) =>
    process.env[name] !== undefined && process.env[name] !== ""
      ? Number(process.env[name]) * 60 * 1000
      : undefined;
  const options = {
    offPeakUtc: process.env.GRADING_OFFPEAK_UTC || undefined,
    remindMs: minutes("GRADING_REMIND_MIN"),
    graceMs: minutes("GRADING_GRACE_MIN"),
    runMarginMs: minutes("GRADING_RUN_MARGIN_MIN"),
    minGapMs: minutes("GRADING_MIN_GAP_MIN"),
    jitterMs: minutes("GRADING_JITTER_MIN"),
  };
  return Object.fromEntries(
    Object.entries(options).filter(
      ([, v]) => v !== undefined && !Number.isNaN(v),
    ),
  );
}

const gradingSchedules = createGradingSchedules({
  db,
  gradingJobs,
  enqueue: (name, payload) => taskQueue.enqueue(name, payload),
  resolvePayer,
  resolveTeacher: findTeacherByEmail,
  hasRefreshToken: (email) => googleUserTokens.hasRefreshToken(email),
  notify: ({ id, type, severity, title, body, data, recipients }) =>
    notifications.createNotification(db, admin, {
      id,
      type,
      severity,
      title,
      body,
      data,
      recipients,
    }),
  async push({ id, type, title, body, data, recipients }) {
    const tokens = await pushDevices.listActiveTokens(db, recipients);
    const base = process.env.PUBLIC_WEB_URL;
    const result = await pushDevices.sendPush(admin, db, {
      tokens,
      title,
      body,
      data: { type, notificationId: id },
      link: base ? `${base.replace(/\/$/, "")}${data?.path || ""}` : undefined,
    });
    await notifications.recordPushResult(db, admin, id, result);
  },
  /** One audit row per week and phase (fixed id: a retry overwrites it). */
  async audit({ id, event, message, run }) {
    const descriptor = auditActions.SYSTEM_ACTIONS["grading.scheduleEvent"];
    await auditLog.recordAudit(db, admin, {
      id,
      requestId: run.jobId || null,
      actorEmail: run.ownerEmail || null,
      actorResolvedFrom: "token",
      action: "grading.scheduleEvent",
      resourceType: descriptor.resourceType,
      severity: message.severity === "WARN" ? "WARN" : descriptor.severity,
      method: "SYSTEM",
      path: "/system/grading-schedule",
      entityId: `${run.classId}/${run.runKey}`,
      success: event !== "failed",
      detail: `${message.title} · ${message.body}`,
    });
  },
  options: scheduleOptionsFromEnv(),
});

const viewerOf = (req) => ({
  email: req.userEmail,
  authKind: req.authKind,
  isAdmin: ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase()),
});

function sendScheduleError(res, err, where) {
  if (err instanceof JobError) {
    return res.status(err.status).json({ error: err.code, ...err.params });
  }
  console.error(`[GRADING-SCHEDULE] ${where}:`, err.message);
  return res.status(500).json({ error: "grading_schedule_failed" });
}

/**
 * Without classId: the schedules of every class the caller teaches (all of
 * them for an admin). With classId: that one, plus how its last week went.
 */
app.get("/grading-schedules", verifyGoogleToken, async (req, res) => {
  try {
    const viewer = viewerOf(req);
    if (req.query.classId) {
      const schedule = await gradingSchedules.get({
        viewer,
        classId: req.query.classId,
      });
      return res.json({ schedule });
    }
    let classIds;
    if (viewer.isAdmin) {
      const snap = await db.collection("classes").get();
      classIds = snap.docs.map((d) => d.id);
    } else {
      const teacher = await findTeacherByEmail(viewer.email);
      if (!teacher) return res.json({ schedules: [] });
      const snap = await db
        .collection("classes")
        .where("teacherId", "array-contains", teacher.id)
        .get();
      classIds = snap.docs.map((d) => d.id);
    }
    return res.json({ schedules: await gradingSchedules.listFor(classIds) });
  } catch (err) {
    return sendScheduleError(res, err, "list");
  }
});

/**
 * What saving these deadlines would schedule. A GET on purpose: it must be
 * free of side effects — the website calls it on every edit of the fields —
 * and GETs are not audited (AUDITED_GETS), unlike any PUT.
 * Declared before /grading-schedules/:classId-style routes.
 */
app.get("/grading-schedules/preview", verifyGoogleToken, async (req, res) => {
  try {
    // ?days=2026-10-06.morning,2026-10-08.evening (grading days); from an
    // older website ?slots=s1-g1,s2-g2 (epoch ms) or the one pair.
    const slots =
      typeof req.query.days === "string"
        ? req.query.days.split(",").map((day) => {
            const [date, part] = day.split(".");
            return { date, part };
          })
        : typeof req.query.slots === "string"
          ? req.query.slots.split(",").map((pair) => {
              const [studentDeadlineAt, graderDeadlineAt] = pair.split("-");
              return { studentDeadlineAt, graderDeadlineAt };
            })
          : undefined;
    const preview = await gradingSchedules.preview({
      viewer: viewerOf(req),
      classId: req.query.classId,
      slots,
      studentDeadlineAt: req.query.studentDeadlineAt,
      graderDeadlineAt: req.query.graderDeadlineAt,
    });
    return res.json({ preview });
  } catch (err) {
    return sendScheduleError(res, err, "preview");
  }
});

/** The most the payer's scheduled classes can cost next time vs the balance. */
app.get("/grading-schedules/estimate", verifyGoogleToken, async (req, res) => {
  try {
    const payer = req.query.classId
      ? await resolvePayer(req.userEmail, req.query.classId)
      : await findTeacherByEmail(req.userEmail);
    if (!payer) return res.status(403).json({ error: "payer_not_found" });
    const estimate = await gradingSchedules.estimate(payer.id, {
      includeClassId: req.query.classId ? String(req.query.classId) : null,
    });
    return res.json({
      ...estimate,
      teacherName: payer.name || payer.gmail || "",
    });
  } catch (err) {
    return sendScheduleError(res, err, "estimate");
  }
});

const weekdayVi = (weekday) =>
  weekday === 0 ? "Chủ nhật" : `Thứ ${weekday + 1}`;
const PART_VI = { morning: "sáng", afternoon: "chiều", evening: "tối" };
const runTimesVi = (runTimes) =>
  Object.entries(runTimes || {})
    .map(([part, time]) => `${PART_VI[part] || part} ${time}`)
    .join(", ");

/**
 * Admin: the default grading time of each part of the day ({runTimes,
 * parts}).
 */
app.get(
  "/grading-schedules/settings",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      return res.json(await gradingSchedules.getSettings());
    } catch (err) {
      return sendScheduleError(res, err, "settings");
    }
  },
);

/**
 * Admin: new default times ({runTimes: {part: "HH:mm"}}); every class
 * follows them for the parts it has no time of its own for.
 */
app.put(
  "/grading-schedules/settings",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const result = await gradingSchedules.setDefaultRunTimes({
        viewer: viewerOf(req),
        runTimes: req.body?.runTimes,
      });
      res.locals.auditDetail =
        `Giờ chấm tự động mặc định: ${runTimesVi(result.runTimes)} ` +
        `(${result.classes} lớp đổi giờ)`;
      return res.json(result);
    } catch (err) {
      return sendScheduleError(res, err, "settings");
    }
  },
);

/** Admin: one class's own times ({runTimes}; a part left out: the default). */
app.put(
  "/grading-schedules/:classId/run-time",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const schedule = await gradingSchedules.setClassRunTimes({
        viewer: viewerOf(req),
        classId: req.params.classId,
        runTimes: req.body?.runTimes ?? {},
      });
      const own = runTimesVi(schedule?.customRunTimes);
      res.locals.auditDetail =
        `Giờ chấm lớp ${schedule?.className || req.params.classId}: ` +
        (own ? `riêng ${own}` : "theo giờ mặc định");
      return res.json({ schedule });
    } catch (err) {
      return sendScheduleError(res, err, "run-time");
    }
  },
);

app.put("/grading-schedules/:classId", verifyGoogleToken, async (req, res) => {
  try {
    const schedule = await gradingSchedules.upsert({
      viewer: viewerOf(req),
      classId: req.params.classId,
      slots: req.body?.slots,
      studentDeadlineAt: req.body?.studentDeadlineAt,
      graderDeadlineAt: req.body?.graderDeadlineAt,
    });
    const day = ({ weekday, time }) => `${weekdayVi(weekday)} ${time}`;
    res.locals.auditDetail =
      `Hẹn ngày chấm lớp ${schedule.className || req.params.classId}: ` +
      schedule.slots
        .map((slot) =>
          slot.kind === "day"
            ? `${PART_VI[slot.part]} ${weekdayVi(slot.weekday)} (${schedule.runTimes?.[slot.part]})`
            : `hạn nộp ${day(slot.studentDeadline)} → hạn chấm ${day(slot.graderDeadline)}`,
        )
        .join("; ");
    return res.json({ schedule });
  } catch (err) {
    return sendScheduleError(res, err, "save");
  }
});

app.delete(
  "/grading-schedules/:classId",
  verifyGoogleToken,
  async (req, res) => {
    try {
      await gradingSchedules.disable({
        viewer: viewerOf(req),
        classId: req.params.classId,
      });
      res.locals.auditDetail = `Tắt chấm tự động lớp ${req.params.classId}`;
      return res.json({ ok: true });
    } catch (err) {
      return sendScheduleError(res, err, "disable");
    }
  },
);

/** Cloud Scheduler, every 5 minutes: queue the steps that are due. */
app.post(
  "/internal/tasks/schedule-tick",
  verifyTickRequest,
  async (req, res) => {
    try {
      const result = await gradingSchedules.tick();
      return res.json(result);
    } catch (err) {
      console.error("[GRADING-SCHEDULE] tick failed:", err.message);
      return res.status(500).json({ error: "tick_failed" });
    }
  },
);

// Local dev has no Cloud Scheduler: tick in-process.
if (taskQueue.mode === "inline") {
  setInterval(() => {
    gradingSchedules
      .tick()
      .catch((err) =>
        console.error("[GRADING-SCHEDULE] inline tick failed:", err.message),
      );
  }, 60 * 1000).unref();
}

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`Server is running on port ${PORT}`);
});
