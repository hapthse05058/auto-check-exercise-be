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
const billing = require("./lib/billing.js");
const { admin, db, serviceAccountPath } = require("./lib/firestore.js");
const teacherFilter = require("./lib/teacherFilter.js");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
// Increase allowed payload size to avoid PayloadTooLargeError for large requests
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

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

/** Normalizes a string for cache keying: collapse whitespace + trim. */
function normalizeForKey(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic gradingCache document id from explicit key fields. Keyed on
 * promptVersion + model + normalized question + normalized answer, so identical
 * answers share one doc and prompt/model changes naturally invalidate old
 * feedback. Used both by grading and by the admin management endpoints (which
 * must re-key a doc when any key field is edited).
 */
function gradingCacheKey(promptVersion, model, question, answer) {
  const raw = `${promptVersion}|${model}|${normalizeForKey(question)}|${normalizeForKey(answer)}`;
  return crypto.createHash("sha1").update(raw).digest("hex");
}

/** gradingCache id for the current PROMPT_VERSION (used by the grading flow). */
function gradingCacheId(question, answer, model) {
  return gradingCacheKey(PROMPT_VERSION, model, question, answer);
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

  try {
    // 1. Defensive dedupe by (question, answer); FE already dedupes.
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
      const key = `${normalizeForKey(item.question)}${normalizeForKey(item.answer)}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, { question: item.question, answer: item.answer });
      }
    }
    const uniqueItems = [...uniqueMap.values()];
    if (uniqueItems.length === 0) {
      return res.status(400).json({ error: "no_items_provided" });
    }

    const cacheRef = db.collection("gradingCache");
    const ids = uniqueItems.map((it) =>
      gradingCacheId(it.question, it.answer, model),
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

    // 7. Return feedback per unique (question, answer). The FE maps these back
    //    to each student by the same pair and writes by question index.
    const results = uniqueItems.map((it, idx) => ({
      question: it.question,
      answer: it.answer,
      feedback: feedbackById.get(ids[idx]) ?? null,
    }));

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
  if (body.question !== null && body.question !== undefined)
    out.question = String(body.question);
  if (body.answer !== null && body.answer !== undefined)
    out.answer = String(body.answer);
  if (body.feedback !== null && body.feedback !== undefined)
    out.feedback = String(body.feedback);
  if (body.model !== null && body.model !== undefined)
    out.model = String(body.model);
  if (body.promptVersion !== null && body.promptVersion !== undefined)
    out.promptVersion = String(body.promptVersion);
  if (body.hitCount !== null && body.hitCount !== undefined)
    out.hitCount = Number(body.hitCount) || 0;
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
      );

      if (newId === id) {
        // Only non-key fields changed (e.g. feedback/hitCount) — update in place.
        await ref.update({
          question: merged.question,
          answer: merged.answer,
          feedback: merged.feedback,
          model: merged.model,
          promptVersion: merged.promptVersion,
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

/** Current point balance of the logged-in teacher (0 when no record yet). */
app.get("/teacher-points/me", verifyGoogleToken, async (req, res) => {
  try {
    const snap = await db
      .collection("TeacherPoint")
      .where("gmail", "==", (req.userEmail || "").toLowerCase())
      .limit(1)
      .get();
    const point = snap.empty ? 0 : (snap.docs[0].data().point ?? 0);
    return res.json({ point });
  } catch (err) {
    console.error("[TEACHER-POINTS] me error:", err);
    return res.status(500).json({ error: "failed_to_get_point" });
  }
});

/** Spends `count` points for the logged-in teacher (after successful writes). */
app.post("/teacher-points/consume", verifyGoogleToken, async (req, res) => {
  try {
    const count = Number(req.body.count);
    if (!Number.isFinite(count) || count <= 0) {
      return res.status(400).json({ error: "invalid_count" });
    }
    const teacher = await findTeacherByEmail(req.userEmail);
    if (!teacher) {
      return res.status(403).json({ error: "teacher_not_found" });
    }
    const ref = db.collection("TeacherPoint").doc(teacher.id);
    const snap = await ref.get();
    if (!snap.exists) {
      await ref.set({
        teacherId: teacher.id,
        gmail: teacher.gmail,
        name: teacher.name || "",
        point: -count,
        topUpHistory: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.json({ point: -count });
    }
    await ref.update({
      point: admin.firestore.FieldValue.increment(-count),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const updated = await ref.get();
    return res.json({ point: updated.data().point ?? 0 });
  } catch (err) {
    console.error("[TEACHER-POINTS] consume error:", err);
    return res.status(500).json({ error: "failed_to_consume" });
  }
});

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
    const classDoc = await classRef.get();
    if (!classDoc.exists) {
      return res.status(404).json({ error: "Class not found" });
    }

    await classRef.update({ currentLesson });
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
