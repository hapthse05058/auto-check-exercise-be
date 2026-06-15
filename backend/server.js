const fs = require("fs");
const path = require("path");
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { OAuth2Client, GoogleAuth } = require("google-auth-library");
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXTENSION_SECRET_KEY = process.env.EXTENSION_SECRET_KEY;
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
const TEST_EMAIL = "studyenglishwithelsa@gmail.com";
// Bump this (or change AI_MODEL) to invalidate the gradingCache: cached
// feedback is keyed on promptVersion + model + question + answer.
const PROMPT_VERSION = process.env.PROMPT_VERSION || "v1";
app.use(cors());
// Increase allowed payload size to avoid PayloadTooLargeError for large requests
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Initialize Firebase Admin
// Use the Cloud Run path, or fallback to a local file for development
const serviceAccountPath = process.env.NODE_ENV === 'production'
  ? '/secrets/firebase-service-account'
  : path.join(__dirname, 'firebase-service-account.json');

if (fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
} else {
  console.error("Critical: Service account file not found!");
}

const db = admin.firestore();

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
    throw new Error("Failed to obtain Google access token from service account");
  }
  return token;
}

if (!process.env.AI_API_KEY && !OPENAI_API_KEY) {
  console.warn(
    "WARNING: AI_API_KEY (DeepSeek) not set. Grading will fail until provided.",
  );
}


async function isClassNameDuplicated(newClassName) {
  const snapshot = await db.collection('classes').get();
  const classes = [];
  snapshot.forEach(doc => {
    classes.push({ id: doc.id, name: doc.data().name.toLowerCase() });
  });
  const duplicateClassSnapshot = classes.filter((cls) => cls.name === newClassName.toLowerCase());
  return duplicateClassSnapshot.length > 0;
}

async function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const secret_key = req.headers["x-api-key"];
  if (secret_key !== EXTENSION_SECRET_KEY) {
    return res.status(401).send('Invalid key');
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Missing Token');
  }

  const token = authHeader.split(' ')[1];

  try {
    // First, try to verify as JWT (for username/password login)
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userEmail = decoded.email;
      return next();
    } catch (jwtError) {
      // If JWT fails, try Google token verification
    }

    // Try Google token verification (for Google OAuth)
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    const userInfo = await response.json();

    if (!userInfo.email) {
      return res.status(401).send('Invalid Token');
    }

    const userEmail = userInfo.email.toLowerCase();
    const teacherDoc = await db.collection("teachers").where("gmail", "==", userEmail).get();
    if (teacherDoc.empty) {
      return res.status(403).json({ error: "Access denied. User is not a registered teacher." });
    }
    req.userEmail = userEmail;
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(401).send('Unauthorized');
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
    .map((item) => `\n[VIETNAMESE]: ${item.question}\n[STUDENT_ANSWER]: ${item.answer}`)
    .join("\n");

  try {
    const inputText = `DATASET TO EVALUATE:\`\`\`\n${studentExercises}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;
    const instructionFilePath = path.join(__dirname, 'prompt_and_instruction_for_responses_api.txt');
    if (!fs.existsSync(instructionFilePath)) {
      throw new Error(`Instruction file not found: ${instructionFilePath}`);
    }
    const prompt_and_instruction_for_ai = fs.readFileSync(instructionFilePath, 'utf8');
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
  return String(value ?? "").replace(/\s+/g, " ").trim();
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
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "phamhongha.innerpiece@gmail.com")
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
const GRADING_CACHE_FIELDS = ["question", "answer", "feedback", "model", "promptVersion"];

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
    return fb != null && fb !== "" ? fb : null;
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
      if (!item || item.question == null || item.answer == null) continue;
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
    const ids = uniqueItems.map((it) => gradingCacheId(it.question, it.answer, model));

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
            if (data && data.feedback != null) {
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
        "prompt_and_instruction_for_responses_api.txt",
      );
      if (!fs.existsSync(instructionFilePath)) {
        throw new Error(`Instruction file not found: ${instructionFilePath}`);
      }
      const instruction = fs
        .readFileSync(instructionFilePath, "utf8")
        .trim();

      const GROUP_SIZE = 15;
      const groups = [];
      for (let i = 0; i < uncached.length; i += GROUP_SIZE) {
        groups.push(uncached.slice(i, i + GROUP_SIZE));
      }

      const CONCURRENCY = Number(process.env.GRADE_GROUP_CONCURRENCY || 4);
      const tasks = groups.map((group) => async () => {
        try {
          const feedbacks = await gradeGroupWithOpenAI(group, instruction, model);
          group.forEach((it, i) => {
            const fb = feedbacks[i];
            if (fb != null) {
              feedbackById.set(ids[it.idx], fb);
              it._feedback = fb; // mark for cache write
            }
          });
        } catch (err) {
          // A failed group leaves its items uncached/unwritten; they retry on
          // the next run. Never block the whole class on one group.
          console.error("[GRADE-CACHED] group grading failed:", err.message);
        }
      });
      await runWithConcurrency(tasks, CONCURRENCY);

      // 5. Persist newly graded feedback (chunked batch writes, <500/batch).
      //    Skipped when caching is off — AI feedback is not stored.
      if (useCache) {
        const toWrite = uncached.filter((it) => it._feedback != null);
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
  if (body.question != null) out.question = String(body.question);
  if (body.answer != null) out.answer = String(body.answer);
  if (body.feedback != null) out.feedback = String(body.feedback);
  if (body.model != null) out.model = String(body.model);
  if (body.promptVersion != null) out.promptVersion = String(body.promptVersion);
  if (body.hitCount != null) out.hitCount = Number(body.hitCount) || 0;
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
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 100, 1), 100);
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
        String(row[field] ?? "").toLowerCase().includes(q),
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
app.post("/grading-cache", verifyGoogleToken, requireAdmin, async (req, res) => {
  try {
    const data = sanitizeCacheInput(req.body);
    if (!data.question || !data.answer || !data.feedback) {
      return res.status(400).json({ error: "question_answer_feedback_required" });
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
});

/**
 * PATCH /grading-cache/:id — edit any field. If a KEY field
 * (question/answer/model/promptVersion) changes, the doc id is re-derived so
 * the grading flow still finds it: the doc is moved to the new id.
 */
app.patch("/grading-cache/:id", verifyGoogleToken, requireAdmin, async (req, res) => {
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
      return res.status(400).json({ error: "question_answer_feedback_required" });
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
      createdAt: existing.createdAt ?? admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.delete(ref);
    await batch.commit();
    return res.json({ id: newId, ...merged });
  } catch (err) {
    console.error("[GRADING-CACHE] update error:", err);
    return res.status(500).json({ error: "failed_to_update" });
  }
});

/** DELETE /grading-cache/:id */
app.delete("/grading-cache/:id", verifyGoogleToken, requireAdmin, async (req, res) => {
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
});

/** POST /grading-cache/bulk-delete — delete many records by id at once. */
app.post("/grading-cache/bulk-delete", verifyGoogleToken, requireAdmin, async (req, res) => {
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
});

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
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    // Query Firestore for teacher with matching username
    const teachersRef = db.collection('teachers');
    const snapshot = await teachersRef.where('username', '==', username).limit(1).get();

    if (snapshot.empty) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const teacherDoc = snapshot.docs[0];
    const teacherData = teacherDoc.data();

    // Verify password using bcrypt
    if (!teacherData.password) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, teacherData.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Generate JWT tokens
    const access_token = jwt.sign(
      { id: teacherDoc.id, email: teacherData.gmail, username: teacherData.username },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const refresh_token = jwt.sign(
      { id: teacherDoc.id, email: teacherData.gmail, username: teacherData.username, type: 'refresh' },
      JWT_SECRET,
      { expiresIn: '30d' }
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
      google_access_token
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
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid refresh token type');
      }

      // Generate new access token
      const access_token = jwt.sign(
        { id: decoded.id, email: decoded.email, username: decoded.username },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      // Also hand back a fresh Google token for the Docs API.
      let google_access_token = null;
      try {
        google_access_token = await getServiceAccountGoogleToken();
      } catch (tokenError) {
        console.error("Failed to mint Google access token:", tokenError.message);
      }

      return res.json({
        access_token,
        expiry_date: Date.now() + 3600 * 1000,
        refresh_token: refreshToken, // Keep the same refresh token
        refresh_token_expires_date: Date.now() + 30 * 24 * 60 * 60 * 1000,
        google_access_token
      });
    } catch (jwtError) {
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
    const teachersRef = db.collection('teachers');
    const snapshot = await teachersRef.where('gmail', '==', userEmail).limit(1).get();

    if (snapshot.empty) {
      return res.status(403).json({ error: 'Teacher not found' });
    }

    const teacherDoc = snapshot.docs[0];
    res.json({ id: teacherDoc.id, ...teacherDoc.data() });
  } catch (error) {
    console.error('Error fetching teacher info:', error);
    res.status(500).json({ error: 'Failed to fetch teacher info' });
  }
});

app.post("/teacher-signup", async (req, res) => {
  
  try {
    const { name, phone, dob, address = '', notes = '', username, password, gmail } = req.body;
    const userEmail = gmail?.trim().toLowerCase();

    if (!name || !phone || !dob) {
      return res.status(400).json({ error: 'Missing required fields: name, phone, dob' });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields: username, password' });
    }

    const teachersRef = db.collection('teachers');
    // Check if teacher with this email already exists
    const existingEmailSnapshot = await teachersRef.where('gmail', '==', userEmail).limit(1).get();
    if (!existingEmailSnapshot.empty) {
      return res.status(409).json({ error: 'Teacher already exists' });
    }
    // Check if username already exists
    const existingUsernameSnapshot = await teachersRef.where('username', '==', username).limit(1).get();
    if (!existingUsernameSnapshot.empty) {
      return res.status(409).json({ error: 'Username already exists' });
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
    console.error('Error creating teacher:', error);
    res.status(500).json({ error: 'Failed to create teacher record' });
  }
});

app.post("/classes", verifyGoogleToken, async (req, res) => {
  try {
    const { name, classType = 'basic', currentLesson = null, teacherId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
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
      return res.status(409).json({ error: 'Class name already exists for this teacher' });
    }

    const classData = {
      name,
      classType,
      currentLesson: currentLesson || null,
      teacherId: [teacherId],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const classRef = await db.collection('classes').add(classData);
    res.status(201).json({ id: classRef.id, ...classData });
  } catch (error) {
    console.error('Error creating class:', error);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

app.get("/classes/check-name", verifyGoogleToken, async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Class name is required' });
    }
    const isDuplicated = await isClassNameDuplicated(name);
    res.json({ exists: isDuplicated });
  } catch (error) {
    console.error('Error checking class name:', error);
    res.status(500).json({ error: 'Failed to verify class name' });
  }
});

app.post("/students", verifyGoogleToken, async (req, res) => {
  try {
    const userEmail = req.userEmail;
    const { classId, students } = req.body;

    if (!classId || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: classId, students' });
    }
    const batch = db.batch();
    const studentsToSave = students
      .map((student) => ({
        classId: classId,
        gmail: student.gmail?.trim(),
        name: student.name?.trim(),
        ggDocLink: student.ggDocLink?.trim() || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }))
      .filter((student) => student.gmail && student.name);

    const tableName = userEmail === TEST_EMAIL ? 'students-testing-table' : 'students';
    studentsToSave.forEach((student) => {
      const docRef = db.collection(tableName).doc();
      batch.set(docRef, {
        ...student
      });
    });

    await batch.commit();
    res.status(201).json({ inserted: studentsToSave.length });
  } catch (error) {
    console.error('Error saving students:', error);
    res.status(500).json({ error: 'Failed to save students' });
  }
});

/**
 * Get classes for the authenticated user
 */
app.get("/classes", verifyGoogleToken, async (req, res) => {
  try {
    const teacherId = req.query.teacherId;
    if (!teacherId) {
      return res.status(400).json({ error: 'teacherId is required' });
    }
    const classesRef = db.collection('classes');
    let snapshot = await classesRef.where('teacherId', 'array-contains', teacherId).get();
    if (snapshot.empty) {
      return res.json([]);
    }
    const classes = [];
    snapshot.forEach(doc => {
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
    const classTypeRef = db.collection('classType');
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
    const userEmail = req.userEmail;
    const classType = req.query.classType;

    if (!classType) {
      return res.status(400).json({ error: "classType is required" });
    }

    const lessonsRef = db.collection('lesson');
    const snapshot = await lessonsRef.where('classType', 'array-contains', classType).get();

    const lessons = [];
    snapshot.forEach(doc => {
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

    const classRef = db.collection('classes').doc(classId);
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
      return res.status(400).json({ error: "classId and currentLesson are required" });
    }

    const classRef = db.collection('classes').doc(classId);
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
 * Get  for the selected class
 */
app.get("/students", verifyGoogleToken, async (req, res) => {
  try {
    const userEmail = req.userEmail;
    const classId = req.query.classId;

    if (!classId) {
      return res.status(400).json({ error: "classId is required" });
    }

    let collectionName = userEmail === TEST_EMAIL ? 'students-testing-table' : 'students';
    const studentsRef = db.collection(collectionName);
    const snapshot = await studentsRef.where('classId', '==', classId).get();

    const students = [];
    snapshot.forEach(doc => {
      students.push({ id: doc.id, ...doc.data() });
    });

    res.json(students);
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});