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
const { admin, db, serviceAccountPath } = require("./lib/firestore.js");
const { findDuplicateDocs } = require("./lib/googleDoc.js");
const {
  TASK_ACTIVE_PASSIVE,
  cleanContent,
  gradingCacheKey,
  normalizeForKey,
  normalizeTaskType,
} = require("./lib/gradingKey.js");
const { parseGradedTable } = require("./lib/parseGradedTable.js");
const notifications = require("./lib/notifications.js");
const pushDevices = require("./lib/pushDevices.js");
const teacherFilter = require("./lib/teacherFilter.js");

const app = express();
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
//Use for extension
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

/**
 * Deterministic TeacherPointLedger document id — the receipt for one student
 * doc. Keyed on payer + doc + lesson so charging the same doc twice (a retry,
 * a re-run) is a no-op instead of a double charge.
 */
function pointLedgerId(payerTeacherId, docId, lessonId) {
  const raw = `${payerTeacherId}|${normalizeForKey(docId)}|${normalizeForKey(lessonId)}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

// Admin allow-list for the gradingCache management endpoints (comma-separated).
const ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS || "phamhongha.innerpiece@gmail.com"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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
  const tableByStt = parseGradedTable(aiResponse, group.length);
  return group.map((_, i) => {
    const fb = tableByStt[String(i + 1)];
    return fb !== null && fb !== undefined && fb !== "" ? fb : null;
  });
}

app.post("/grade-cached", verifyGoogleToken, async (req, res) => {
  const items = req.body.items;
  const model = AI_MODEL;
  // Only admins may turn the cache OFF; everyone else always uses it. When off,
  // we skip the cache lookup (every answer goes to the AI) and skip persisting
  // the AI feedback to gradingCache.
  const isAdmin = ADMIN_EMAILS.includes((req.userEmail || "").toLowerCase());
  const useCache = !(isAdmin && req.body.useCache === false);

  if (!Array.isArray(items) || items.length === 0) {
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
      const question = cleanContent(item.question);
      const answer = cleanContent(item.answer);
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
    if (uniqueItems.length === 0) {
      return res.status(400).json({ error: "no_items_provided" });
    }

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
      const instructionFilePath = path.join(
        __dirname,
        "prompt_and_instruction_for_responses_api_2.txt",
      );
      if (!fs.existsSync(instructionFilePath)) {
        throw new Error(`Instruction file not found: ${instructionFilePath}`);
      }
      const instruction = fs.readFileSync(instructionFilePath, "utf8").trim();

      const GROUP_SIZE = 15;
      const groups = [];
      // Một request được phép chứa CẢ HAI loại bài: mỗi mục tự mang nhãn của
      // nó ([VIETNAMESE] / [TASK]: ACTIVE_TO_PASSIVE) và prompt có section
      // "QUY TẮC CHO DATASET HỖN HỢP" dạy model đọc nhãn để chọn quy tắc chấm.
      // Nhờ vậy nhóm dở dang của loại này không còn tốn riêng một lần gọi AI.
      // Chốt chặn nếu model vẫn lẫn: parseGradedTable ném lỗi khi STT trùng
      // hoặc vượt 1..group.length — group đó fail và chấm lại, thay vì ghi
      // feedback SAI NGƯỜI vào gradingCache vĩnh viễn.
      for (let i = 0; i < uncached.length; i += GROUP_SIZE) {
        groups.push(uncached.slice(i, i + GROUP_SIZE));
      }

      const CONCURRENCY = Number(process.env.GRADE_GROUP_CONCURRENCY || 4);
      const groupErrors = [];
      const tasks = groups.map((group) => async () => {
        try {
          const feedbacks = await gradeGroupWithOpenAI(
            group,
            instruction,
            model,
          );
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
          requestId: req.requestId,
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
    const results = uniqueItems.flatMap((it, idx) =>
      it.originals.map((orig) => ({
        ...orig,
        feedback: feedbackById.get(ids[idx]) ?? null,
      })),
    );

    return res.json({ success: true, results });
  } catch (err) {
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
// TeacherPoint — point balance per teacher (1 point spent per student doc whose
// feedback is written), top-up history, and an admin billing summary.
//   point = topUpVnd / 700 ;  saler commission = topUpVnd / 700 * 100
// Admin-only CRUD + top-up. Teachers only read their own balance / consume it.
// ---------------------------------------------------------------------------

const TOPUP_STEP_VND = 60000;
const TOPUP_MAX_VND = 6000000;
const VND_PER_POINT = 600;

/** Validates a top-up amount: integer multiple of 60k within [60k, 6M]. */
function isValidTopUp(amountVnd) {
  return (
    Number.isInteger(amountVnd) &&
    amountVnd >= TOPUP_STEP_VND &&
    amountVnd <= TOPUP_MAX_VND &&
    amountVnd % TOPUP_STEP_VND === 0
  );
}

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
    const teacher = await findTeacherByEmail(req.userEmail);
    if (!teacher) return res.json({ point: 0 });
    const snap = await db.collection("TeacherPoint").doc(teacher.id).get();
    const point = snap.exists ? (snap.data().point ?? 0) : 0;
    return res.json({ point });
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
    const snap = await db.collection("TeacherPoint").doc(payer.id).get();
    return res.json({
      point: snap.exists ? (snap.data().point ?? 0) : 0,
      teacherId: payer.id,
      teacherName: payer.name || payer.gmail || "",
    });
  } catch (err) {
    console.error("[TEACHER-POINTS] payer error:", err);
    return res.status(500).json({ error: "failed_to_get_payer" });
  }
});

/**
 * Spends 1 point per student doc whose feedback was just written.
 *
 * The client sends the docs it has finished, NOT an amount: what those docs
 * cost is the server's decision. Each doc gets a TeacherPointLedger receipt
 * keyed by pointLedgerId(), and only docs without one are billable — so a
 * retry (whole or partial) settles exactly what is still owed and never
 * double-charges. The balance check and the debit share one transaction, which
 * is what keeps the balance from going negative.
 */
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

    const lessonId = req.body.lessonId || null;
    const pointRef = db.collection("TeacherPoint").doc(payer.id);
    const ledgerRefs = docIds.map((docId) =>
      db
        .collection("TeacherPointLedger")
        .doc(pointLedgerId(payer.id, docId, lessonId)),
    );

    const result = await db.runTransaction(async (tx) => {
      // Every read must happen before the first write in a transaction.
      const ledgerSnaps = await tx.getAll(...ledgerRefs);
      const pointSnap = await tx.get(pointRef);
      const current = pointSnap.exists ? (pointSnap.data().point ?? 0) : 0;

      const billable = docIds.filter((_, i) => !ledgerSnaps[i].exists);
      if (!billable.length) return { point: current, charged: 0 };
      if (current < billable.length) {
        return { point: current, charged: 0, need: billable.length };
      }

      // set+merge with increment also covers "no record yet", so there is no
      // read-then-create race between two concurrent charges.
      tx.set(
        pointRef,
        {
          teacherId: payer.id,
          gmail: payer.gmail || "",
          name: payer.name || "",
          point: admin.firestore.FieldValue.increment(-billable.length),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      billable.forEach((docId) => {
        tx.set(
          db
            .collection("TeacherPointLedger")
            .doc(pointLedgerId(payer.id, docId, lessonId)),
          {
            payerTeacherId: payer.id,
            classId: req.body.classId || null,
            docId,
            lessonId,
            chargedByEmail: req.userEmail,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        );
      });
      return { point: current - billable.length, charged: billable.length };
    });

    if (result.need) {
      return res.status(402).json({
        error: "insufficient_points",
        point: result.point,
        need: result.need,
      });
    }
    return res.json({
      point: result.point,
      charged: result.charged,
      payerTeacherId: payer.id,
      payerName: payer.name || payer.gmail || "",
    });
  } catch (err) {
    console.error("[TEACHER-POINTS] consume error:", err);
    return res.status(500).json({ error: "failed_to_consume" });
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
    // Point total leads: the audit screen clips the detail column at 220px, so
    // whatever comes first is the only part read without hovering.
    res.locals.auditDetail =
      `Tổng point bị trừ: ${Number(req.body.totalPoints) || 0} · ` +
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
 * Admin: the billing summary. `totalTopUpVnd` is the lifetime revenue (the amount
 * the admin records/receives). `totalCommissionVnd` is the saler's cut, shown for
 * the admin's information only (the saler takes it upfront — it does not reduce
 * the admin's revenue).
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

      const buildRow = (id, teacherId, source, point) => {
        const history = Array.isArray(source?.topUpHistory)
          ? source.topUpHistory
          : [];
        const mappedHistory = history.map((h) => ({
          amountVnd: h.amountVnd ?? 0,
          points: h.points ?? 0,
          topUpAt: h.topUpAt?.toDate?.().toISOString() ?? null,
        }));
        return {
          id,
          teacherId,
          gmail: source?.gmail ?? "",
          name: source?.name ?? "",
          point,
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
          buildRow(pd?.docId ?? doc.id, doc.id, source, pd?.point ?? 0),
        );
        seen.add(doc.id);
      });

      // Orphan point records whose teacher doc was deleted — keep them visible.
      pointSnap.forEach((doc) => {
        const d = doc.data();
        const teacherId = d.teacherId ?? doc.id;
        if (seen.has(teacherId)) return;
        records.push(buildRow(doc.id, teacherId, d, d.point ?? 0));
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
      const point = Number(req.body.point) || 0;
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
        point,
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

/** Admin: set a teacher's point balance directly (lazy-creates the record). */
app.patch(
  "/teacher-points/:id",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      if (
        req.body.point === null ||
        req.body.point === undefined ||
        !Number.isFinite(Number(req.body.point))
      ) {
        return res.status(400).json({ error: "invalid_point" });
      }
      const point = Number(req.body.point);
      const ref = db.collection("TeacherPoint").doc(req.params.id);
      if ((await ref.get()).exists) {
        await ref.update({
          point,
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
          point,
          topUpHistory: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return res.json({ id: req.params.id, point });
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
 * Admin: top up a teacher's points from a VND amount. Adds the computed points,
 * appends a history entry, and bumps the global admin billing total.
 */
app.post(
  "/teacher-points/:id/topup",
  verifyGoogleToken,
  requireAdmin,
  async (req, res) => {
    try {
      const amountVnd = Number(req.body.amountVnd);
      if (!isValidTopUp(amountVnd)) {
        return res.status(400).json({ error: "invalid_amount" });
      }
      const ref = db.collection("TeacherPoint").doc(req.params.id);
      if (!(await ref.get()).exists) {
        // No record yet — create one (id === teacherId) before topping up.
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
          point: 0,
          topUpHistory: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      const points = amountVnd / VND_PER_POINT;
      await ref.update({
        point: admin.firestore.FieldValue.increment(points),
        topUpHistory: admin.firestore.FieldValue.arrayUnion({
          amountVnd,
          points,
          topUpAt: admin.firestore.Timestamp.now(),
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      // Bump the admin billing total (lazy-create the singleton).
      await db
        .collection("AdminBilling")
        .doc("summary")
        .set(
          {
            totalTopUpVnd: admin.firestore.FieldValue.increment(amountVnd),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      const updated = await ref.get();
      return res.json({
        id: req.params.id,
        point: updated.data().point ?? 0,
        addedPoints: points,
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

    res.json(tokens);
  } catch (error) {
    console.error("Error exchanging code:", error);
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

    res.json({
      access_token: credentials.access_token,
      expiry_date: credentials.expiry_date || 3600 * 1000 + Date.now(),
      refresh_token: credentials.refresh_token,
      refresh_token_expires_date:
        Date.now() + credentials.refresh_token_expires_in * 1000,
    });
  } catch (error) {
    console.error("Error refreshing token:", error);
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
    res.json({ id: teacherDoc.id, ...teacherDoc.data() });
  } catch (error) {
    console.error("Error fetching teacher info:", error);
    res.status(500).json({ error: "Failed to fetch teacher info" });
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
      currentLesson = null,
      teacherId,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Missing required field: name" });
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
      classType,
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
      classes.push({ id: doc.id, ...doc.data() });
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
    const classTypeRef = db.collection("classType");
    const snapshot = await classTypeRef.get();

    const classTypes = [];
    snapshot.forEach((doc) => {
      classTypes.push({ id: doc.id, ...doc.data() });
    });

    res.json(classTypes);
  } catch (error) {
    console.error("Error fetching class types:", error);
    res.status(500).json({ error: "Failed to fetch class types" });
  }
});

app.get("/lessons", verifyGoogleToken, async (req, res) => {
  try {
    const classType = req.query.classType;

    if (!classType) {
      return res.status(400).json({ error: "classType is required" });
    }

    const lessonsRef = db.collection("lesson");
    const snapshot = await lessonsRef
      .where("classType", "array-contains", classType)
      .get();

    const lessons = [];
    snapshot.forEach((doc) => {
      lessons.push({ id: doc.id, ...doc.data() });
    });

    res.json(lessons);
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
 */
app.get("/classes/all", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const [classSnap, teacherSnap] = await Promise.all([
      db.collection("classes").where("isActive", "==", true).get(),
      db.collection("teachers").get(),
    ]);
    const teacherNameById = new Map();
    teacherSnap.forEach((doc) => {
      const d = doc.data();
      teacherNameById.set(doc.id, d.name || d.gmail || doc.id);
    });
    const classes = [];
    classSnap.forEach((doc) => {
      const d = doc.data();
      const teacherIds = Array.isArray(d.teacherId) ? d.teacherId : [];
      classes.push({
        id: doc.id,
        name: d.name ?? "",
        classType: d.classType ?? "",
        currentLesson: d.currentLesson ?? null,
        isActive: d.isActive,
        teacherId: teacherIds,
        teacherNames: teacherIds.map((id) => teacherNameById.get(id) || id),
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

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    await classRef.update(updates);
    res.json({ success: true, ...updates });
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

app.listen(PORT, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`Server is running on port ${PORT}`);
});
