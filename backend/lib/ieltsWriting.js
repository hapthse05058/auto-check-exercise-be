/**
 * IELTS Writing grading — everything the "ielts" grading profile needs, kept
 * apart from Basic on purpose: its own prompt (prompt_ielts_writing.txt), its
 * own prompt version, its own model (Task 1 charts are read into text first by
 * lib/ieltsChartData.js when a chart reader is configured), its own cache
 * collection and its own output format. Nothing here is used by the Basic path, and nothing of
 * the Basic path (gradeItemsCached, gradingKey.js, prompt_*.txt) is used here.
 *
 * Why a separate cache COLLECTION rather than `gradingCache`: that collection
 * is re-keyed wholesale by scripts/cleanGradingCache.js and by the admin cache
 * editor, both with Basic's key function — which would fold an IELTS record
 * into a "vi_en" key and strip its lines. Keeping IELTS out of it is the only
 * way neither side can corrupt the other.
 *
 * The AI answers in a fixed JSON shape (see parseIeltsResponse). Overall band
 * and word count are computed here, never taken from the model.
 */
const crypto = require("crypto");

const CACHE_COLLECTION = "ieltsGradingCache";

const TASK_1 = "task1";
const TASK_2 = "task2";
const TASK_PARAGRAPH = "paragraph";
const TASKS = [TASK_1, TASK_2, TASK_PARAGRAPH];

/** The criteria a task is judged on — exactly these keys, each once. */
const CRITERIA_KEYS = {
  [TASK_1]: ["TA", "CC", "LR", "GRA"],
  [TASK_2]: ["TR", "CC", "LR", "GRA"],
  [TASK_PARAGRAPH]: [],
};

const CRITERIA_NAMES = {
  TA: "Task Achievement",
  TR: "Task Response",
  CC: "Coherence & Cohesion",
  LR: "Lexical Resource",
  GRA: "Grammatical Range & Accuracy",
};

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/;
const MAX_PROMPT_CHARS = 5000;
const MAX_ESSAY_CHARS = 12000;
/** One immediate retry when the model errors or answers malformed JSON. */
const MAX_ATTEMPTS = 2;
/**
 * One attempt more, only while the best answer so far still drops words of
 * the student (silentEdits) — e.g. the retry that named them came back as
 * broken JSON. Rare, and never taken when an attempt is clean.
 */
const MAX_REPAIR_ATTEMPTS = 3;

/** A request the caller should answer with `status` and `{error: code}`. */
class IeltsError extends Error {
  constructor(status, code, params = null) {
    super(code);
    this.name = "IeltsError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** "data:image/png;base64,...." → {mime, buffer}, or null. */
function parseDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(
    String(value ?? ""),
  );
  if (!match) return null;
  return {
    mime: match[1].toLowerCase(),
    buffer: Buffer.from(match[2], "base64"),
  };
}

/** Tasks that come with a chart: required for Task 1, optional for a
 * paragraph (an Introduction/Overview or sentences about a Task 1 chart). */
const CHART_TASKS = [TASK_1, TASK_PARAGRAPH];

/**
 * Checks and normalises one grading request. Images are kept for Task 1 (the
 * chart; refused without one, since the data cannot be checked) and for a
 * paragraph written about a chart; Task 2 ignores them.
 *
 * @param {{task, prompt, essay, images?: Array<string|{mime, buffer}>}} input
 *   images as data URLs (website) or {mime, buffer} (read from a Google Doc).
 * @returns {{task, prompt, essay, images: Array<{mime, buffer, hash}>}}
 * @throws {IeltsError} 400
 */
function validateRequest(input) {
  const body = input && typeof input === "object" ? input : {};
  const task = String(body.task ?? "");
  if (!TASKS.includes(task)) throw new IeltsError(400, "invalid_task");

  const prompt = String(body.prompt ?? "").trim();
  const essay = String(body.essay ?? "").trim();
  if (!prompt) throw new IeltsError(400, "prompt_required");
  if (!essay) throw new IeltsError(400, "essay_required");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new IeltsError(400, "prompt_too_long", { max: MAX_PROMPT_CHARS });
  }
  if (essay.length > MAX_ESSAY_CHARS) {
    throw new IeltsError(400, "essay_too_long", { max: MAX_ESSAY_CHARS });
  }

  const raw =
    body.images === undefined || body.images === null ? [] : body.images;
  if (!Array.isArray(raw)) throw new IeltsError(400, "invalid_image");
  if (task === TASK_1 && raw.length === 0) {
    throw new IeltsError(400, "chart_required");
  }
  const images = CHART_TASKS.includes(task) ? normalizeImages(raw) : [];
  return { task, prompt, essay, images };
}

/**
 * Charts as {mime, buffer, hash}, from data URLs (website) or {mime, buffer}
 * (read from a Google Doc).
 *
 * @throws {IeltsError} 400 too_many_images | invalid_image | image_too_large
 */
function normalizeImages(raw) {
  if (!Array.isArray(raw)) throw new IeltsError(400, "invalid_image");
  if (raw.length > MAX_IMAGES) {
    throw new IeltsError(400, "too_many_images", { max: MAX_IMAGES });
  }
  return raw.map((item) => {
    const image =
      typeof item === "string"
        ? parseDataUrl(item)
        : item && Buffer.isBuffer(item.buffer)
          ? {
              mime: String(item.mime || "").toLowerCase(),
              buffer: item.buffer,
            }
          : null;
    if (!image || !IMAGE_MIME.test(image.mime) || !image.buffer.length) {
      throw new IeltsError(400, "invalid_image");
    }
    if (image.buffer.length > MAX_IMAGE_BYTES) {
      throw new IeltsError(400, "image_too_large", { max: MAX_IMAGE_BYTES });
    }
    return { ...image, hash: sha256(image.buffer) };
  });
}

/** Line endings, trailing spaces and runs of blank lines do not change a text. */
function normalizeForKey(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Identity of one graded input: task + prompt + essay + every chart, in order.
 * The chart hashes are PART of it — the same essay about a different chart is
 * a different submission.
 */
function inputIdentity({ task, prompt, essay, images }) {
  return JSON.stringify([
    task,
    normalizeForKey(prompt),
    normalizeForKey(essay),
    (images || []).map((image) => image.hash),
  ]);
}

/**
 * ieltsGradingCache document id: prompt version + model + input identity, and
 * — when the chart was read into text first (lib/ieltsChartData.js) — that
 * text, so a re-read chart grades afresh.
 */
function ieltsCacheKey({ promptVersion, model, chartData = null, ...input }) {
  const chart = chartData ? `|chart:${sha256(normalizeForKey(chartData))}` : "";
  return crypto
    .createHash("sha1")
    .update(`ielts|${promptVersion}|${model}|${inputIdentity(input)}${chart}`)
    .digest("hex");
}

/** Receipt id for the paste page: one charge per teacher per submission. */
function pasteReceiptDocId(input) {
  return `ielts-paste:${sha256(inputIdentity(input))}`;
}

function countWords(text) {
  return String(text ?? "")
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * Overall band from the four criterion bands, by the IELTS rule: take the
 * average, then round to the nearest half band, where an average ending in
 * .25 goes UP to .5 and one ending in .75 goes UP to the next whole band
 * (.0 and .5 stay). Criterion bands are whole numbers, so the average can
 * only end in .0/.25/.5/.75; dividing by 4 and multiplying by 2 are exact in
 * floating point, and Math.round rounds the .5 of the doubled value up —
 * which is precisely the rule. Null when there are no criteria (paragraph).
 */
function overallBand(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) return null;
  const sum = criteria.reduce((total, c) => total + c.band, 0);
  return Math.round((sum / criteria.length) * 2) / 2;
}

const isText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * The model's answer as a clean result, or null when it cannot be trusted —
 * the caller then retries (once) and never caches it.
 *
 * Rejects missing, mistyped or duplicated expected fields; ignores any EXTRA
 * field the model adds (it is dropped, not stored, not returned).
 *
 * @returns {{task, corrected, improved,
 *   criteria: Array<{key, band, comment}>, general, advice}|null}
 */
function parseIeltsResponse(text, expectedTask) {
  let raw = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fenced) raw = fenced[1];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const task = data.task;
  if (!TASKS.includes(task)) return null;
  if (expectedTask && task !== expectedTask) return null;
  for (const field of ["corrected", "improved", "general", "advice"]) {
    if (!isText(data[field])) return null;
  }
  if (!Array.isArray(data.criteria)) return null;

  const expected = CRITERIA_KEYS[task];
  if (data.criteria.length !== expected.length) return null;
  const seen = new Set();
  const criteria = [];
  for (const item of data.criteria) {
    if (!item || typeof item !== "object") return null;
    const { key, band, comment } = item;
    if (!expected.includes(key) || seen.has(key)) return null;
    if (!Number.isInteger(band) || band < 1 || band > 9) return null;
    if (!isText(comment)) return null;
    seen.add(key);
    criteria.push({ key, band, comment: comment.trim() });
  }
  // Report the criteria in the canonical order, whatever order they came in.
  criteria.sort((a, b) => expected.indexOf(a.key) - expected.indexOf(b.key));

  return {
    task,
    corrected: data.corrected.trim(),
    improved: data.improved.trim(),
    criteria,
    general: data.general.trim(),
    advice: data.advice.trim(),
  };
}

/** A word as compared by silentEdits: lower case, outer punctuation off
 * (a leading "$"/"£" and a trailing "%" stay — dropping them is an edit). */
function comparableWord(token) {
  return token
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}$£%]+|[^\p{L}\p{N}%]+$/gu, "");
}

/** The comparable words of a text, each with the line it is on. */
function wordsByLine(text) {
  const words = [];
  String(text ?? "")
    .split("\n")
    .forEach((line, lineNo) => {
      for (const token of line.replace(/\*\*/g, " ").split(/\s+/)) {
        const word = comparableWord(token);
        if (word) words.push({ word, line: lineNo });
      }
    });
  return words;
}

/**
 * Longest common subsequence of two word lists.
 * @returns {{pairs: Array<[number, number]>, missing: number[]}} the matched
 *   index pairs [i in a, k in b] in order, and the indexes of a left out.
 */
function alignWords(a, b) {
  const n = a.length;
  const m = b.length;
  // lcs[i][k] = LCS length of a[i..] and b[k..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let k = m - 1; k >= 0; k--) {
      lcs[i][k] =
        a[i] === b[k]
          ? lcs[i + 1][k + 1] + 1
          : Math.max(lcs[i + 1][k], lcs[i][k + 1]);
    }
  }
  const pairs = [];
  const missing = [];
  for (let i = 0, k = 0; i < n;) {
    if (k < m && a[i] === b[k]) {
      pairs.push([i++, k++]);
    } else if (k < m && lcs[i][k + 1] >= lcs[i + 1][k]) {
      k++;
    } else {
      missing.push(i++);
    }
  }
  return { pairs, missing };
}

/**
 * The student's words the "corrected" text changed or dropped WITHOUT marking
 * them. A marked fix keeps the wrong word ("**wrong** → right"), so every word
 * of the essay must still be in the corrected text, in order: whatever falls
 * outside their longest common subsequence was edited silently — the student
 * would never see that it was wrong (e.g. a "%" added to "13" unmarked).
 *
 * @returns {Array<{words: string, context: string}>} one entry per run of
 *   missing words (runs at most 2 words apart are merged), empty when clean.
 */
function silentEdits(essay, corrected) {
  const orig = wordsByLine(essay).map((w) => w.word);
  const corr = wordsByLine(corrected).map((w) => w.word);
  const { missing } = alignWords(orig, corr);
  const runs = [];
  for (const i of missing) {
    const last = runs[runs.length - 1];
    if (last && i - last.end <= 2) last.end = i;
    else runs.push({ start: i, end: i });
  }
  return runs.map(({ start, end }) => ({
    words: orig.slice(start, end + 1).join(" "),
    context: orig.slice(Math.max(0, start - 4), end + 5).join(" "),
  }));
}

const isNoteLine = (line) => /^\s*\*\*\[/.test(line);

/**
 * Puts the student's line breaks back: the model sometimes starts a new line
 * after a fix's "(explanation)", splitting one paragraph of the student into
 * a line per sentence. Each line of the corrected text is traced (by word
 * alignment) to the student line its first word comes from; a line from the
 * same student line as the one before it is joined back onto it (dropping
 * the blank lines between). Note lines ("**[...]** → …") always stay on their
 * own line, and the student's own line breaks are never removed.
 */
function restoreLines(essay, corrected) {
  const orig = wordsByLine(essay);
  const corr = wordsByLine(corrected);
  const lines = String(corrected ?? "").split("\n");
  const { pairs } = alignWords(
    orig.map((w) => w.word),
    corr.map((w) => w.word),
  );
  const source = new Map(); // corrected line → student line of its 1st word
  for (const [i, k] of pairs) {
    if (!source.has(corr[k].line)) source.set(corr[k].line, orig[i].line);
  }
  const out = [];
  let last = -1; // index in out of the last line with text
  let lastSource;
  lines.forEach((line, n) => {
    const from = source.get(n);
    const note = isNoteLine(line);
    if (!note && from !== undefined && from === lastSource) {
      out.length = last + 1;
      out[last] = `${out[last].replace(/\s+$/, "")} ${line.trim()}`;
      return;
    }
    out.push(line);
    if (line.trim()) {
      last = out.length - 1;
      lastSource = note ? undefined : from;
    }
  });
  return out.join("\n");
}

/** The note added to a retry after silent edits: what to keep this time. */
function silentEditReminder(edits) {
  const list = edits
    .slice(0, 12)
    .map((e) => `- "${e.words}" (trong: …${e.context}…)`)
    .join("\n");
  return (
    `[KIỂM TRA LẠI] Ở lần trả lời trước, bản chữa ("corrected") đã tự đổi hoặc bỏ ` +
    `những chữ sau của học viên mà KHÔNG đánh dấu:\n${list}\n` +
    `Mọi chữ của học viên phải còn nguyên trong "corrected": chỗ nào cần sửa thì ` +
    `in đậm chữ gốc rồi "→ cách sửa", chỗ nào đúng thì chép y nguyên. ` +
    `Hãy trả lời lại TOÀN BỘ object JSON.`
  );
}

/** What a caller gets: the stored result plus what the server computes. */
function describeResult(result, essay) {
  return {
    ...result,
    criteria: result.criteria.map((c) => ({
      ...c,
      name: CRITERIA_NAMES[c.key],
    })),
    overall: overallBand(result.criteria),
    wordCount: countWords(essay),
  };
}

/** IELTS minimum length per task; a paragraph has none. */
const MIN_WORDS = { [TASK_1]: 150, [TASK_2]: 250, [TASK_PARAGRAPH]: 0 };

/**
 * The user message: labelled text, then the chart images, if any. The
 * word count is computed here and stated as a fact, with the verdict against
 * the minimum — models miscount, and missed the "too short" note without it.
 *
 * With `chartData` (the chart already read into text) the data goes in as a
 * labelled section and the images are NOT sent.
 */
function buildUserContent({ task, prompt, essay, images, chartData = null }) {
  const words = countWords(essay);
  const min = MIN_WORDS[task];
  const length = min
    ? `${words} từ; tối thiểu ${min} từ → ${words < min ? "BÀI CÒN NGẮN" : "đủ độ dài"}`
    : `${words} từ`;
  const chart = chartData
    ? `[DỮ LIỆU BIỂU ĐỒ] (đã trích từ ảnh đề bài):\n${chartData}\n\n`
    : "";
  const text =
    `[TASK]: ${task}\n\n` +
    `[ĐỀ BÀI]:\n${prompt}\n\n` +
    chart +
    `[BÀI LÀM CỦA HỌC VIÊN] (${length}):\n${essay}`;
  return [
    { type: "text", text },
    ...(chartData ? [] : images || []).map((image) => ({
      type: "image_url",
      image_url: {
        url: `data:${image.mime};base64,${image.buffer.toString("base64")}`,
      },
    })),
  ];
}

/**
 * Keeps only the "**bold**" markup the doc writer understands: a line with an
 * unpaired "**" loses its last one (the writer's bold regex is per line), and
 * single-"*" italics, which would show up as literal asterisks, are unwrapped.
 */
function cleanMarkup(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => {
      let out = line.replace(/(?<!\*)\*(?!\*)([^*\n]+?)(?<!\*)\*(?!\*)/g, "$1");
      if ((out.match(/\*\*/g) || []).length % 2 === 1) {
        const at = out.lastIndexOf("**");
        out = out.slice(0, at) + out.slice(at + 2);
      }
      return out.replace(/\s+$/, "");
    })
    .join("\n");
}

/**
 * The feedback in its three parts, each plain text with "**bold**" markers:
 * the corrected writing, the improved version and the review. The teachers'
 * table (lib/doc/ieltsDoc.js, layout "pair") puts the first two side by side
 * and the review below. No numbering, no band and no overall: the teachers
 * asked for feedback that reads like their own (the bands still steer the
 * model's comments, they are just not shown).
 * `general` and `advice` alone are for the "review" layout (2026-10-09),
 * which writes them under its own "Nhận xét chung" / "Lời khuyên cải thiện"
 * lines.
 */
function ieltsFeedbackParts(described) {
  const general = cleanMarkup(described.general);
  const advice = cleanMarkup(described.advice);
  const review = described.criteria.map(
    (c) => `- **${c.name}:** ${cleanMarkup(c.comment)}`,
  );
  review.push(`**Nhận xét chung:** ${general}`);
  review.push(`**Lời khuyên cải thiện:** ${advice}`);
  return {
    corrected: cleanMarkup(described.corrected),
    improved: cleanMarkup(described.improved),
    review: review.join("\n"),
    general,
    advice,
  };
}

/**
 * The feedback as one plain text with "**bold**" markers — what is written
 * below the heading of the older doc layouts and what the website renders
 * and copies.
 */
function formatIeltsFeedback(described) {
  const parts = ieltsFeedbackParts(described);
  return [
    "**BẢN CHỮA**",
    parts.corrected,
    "",
    "**BẢN CẢI THIỆN**",
    parts.improved,
    "",
    "**NHẬN XÉT**",
    parts.review,
  ].join("\n");
}

/**
 * @param deps.db            Firestore
 * @param deps.callModel     (instruction, content, model) => Promise<string>
 * @param deps.readPrompt    () => string (the system prompt)
 * @param deps.model         model id
 * @param deps.promptVersion IELTS_PROMPT_VERSION
 * @param deps.readChart     optional (images, {useCache, requestId}) =>
 *   Promise<{data}> — lib/ieltsChartData.js. When given, a Task 1 chart is
 *   read into text first and the model grades from that text; without it the
 *   model gets the images.
 * @param deps.now           () => ms
 */
function createIeltsGrader({
  db,
  callModel,
  readPrompt,
  model,
  promptVersion,
  readChart = null,
  now = () => Date.now(),
  // eslint-disable-next-line no-console
  log = (...args) => console.log("[IELTS]", ...args),
}) {
  const cache = () => db.collection(CACHE_COLLECTION);

  /**
   * One model answer, retried once when the call fails, the JSON is unusable,
   * or the corrected text edits the student's words silently (silentEdits) —
   * that retry names the words to keep, and the attempt that lost the fewest
   * words wins. While the best answer still loses words after two attempts,
   * one more is made (MAX_REPAIR_ATTEMPTS). Null when no attempt is usable.
   */
  async function askModel(input, chartData, requestId) {
    const instruction = readPrompt();
    const content = buildUserContent({ ...input, chartData });
    let best = null;
    let reminder = null;
    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      if (attempt > MAX_ATTEMPTS && !best?.lost) break;
      let text;
      try {
        text = await callModel(
          instruction,
          reminder ? [...content, { type: "text", text: reminder }] : content,
          model,
        );
      } catch (err) {
        log(
          `${requestId || "-"} attempt ${attempt}: model error ${err.message}`,
        );
        continue;
      }
      const parsed = parseIeltsResponse(text, input.task);
      if (!parsed) {
        log(`${requestId || "-"} attempt ${attempt}: invalid response`);
        continue;
      }
      parsed.corrected = restoreLines(input.essay, parsed.corrected);
      const edits = silentEdits(input.essay, parsed.corrected);
      const lost = edits.reduce((n, e) => n + e.words.split(" ").length, 0);
      if (!best || lost < best.lost) best = { parsed, lost };
      if (!edits.length) break;
      log(
        `${requestId || "-"} attempt ${attempt}: ${edits.length} silent edit(s): ` +
          edits.map((e) => e.words).join(" | "),
      );
      reminder = silentEditReminder(edits);
    }
    return best ? best.parsed : null;
  }

  /**
   * Grades one validated submission (see validateRequest).
   *
   * @returns {Promise<{result: object, feedback: string, parts: object,
   *   cached: boolean, chartData: string|null}>}
   *   `parts` = ieltsFeedbackParts (corrected / improved / review);
   *   `result` = describeResult (criteria with names, overall, wordCount);
   *   `chartData` = the chart as the model was given it (readChart), or null.
   * @throws {IeltsError} 502 `ielts_ai_invalid` when the model fails twice,
   *   or `ielts_chart_unreadable` from readChart — nothing is cached then.
   */
  async function grade(input, { useCache = true, requestId } = {}) {
    const chartData =
      readChart && CHART_TASKS.includes(input.task) && input.images.length
        ? (await readChart(input.images, { useCache, requestId })).data
        : null;
    const id = ieltsCacheKey({ promptVersion, model, chartData, ...input });
    const ref = cache().doc(id);

    if (useCache) {
      const snap = await ref.get();
      const stored = snap.exists ? snap.data()?.result : null;
      if (stored) {
        ref
          .update({
            hitCount: (snap.data().hitCount || 0) + 1,
            lastHitAt: now(),
          })
          .catch(() => {});
        const result = describeResult(stored, input.essay);
        return {
          result,
          feedback: formatIeltsFeedback(result),
          parts: ieltsFeedbackParts(result),
          cached: true,
          chartData,
        };
      }
    }

    const parsed = await askModel(input, chartData, requestId);
    if (!parsed) throw new IeltsError(502, "ielts_ai_invalid");

    await ref.set({
      task: input.task,
      prompt: input.prompt,
      essay: input.essay,
      imageHashes: input.images.map((image) => image.hash),
      chartData,
      result: parsed,
      model,
      promptVersion,
      hitCount: 0,
      createdAt: now(),
    });
    const result = describeResult(parsed, input.essay);
    return {
      result,
      feedback: formatIeltsFeedback(result),
      parts: ieltsFeedbackParts(result),
      cached: false,
      chartData,
    };
  }

  return { grade };
}

module.exports = {
  CACHE_COLLECTION,
  CRITERIA_KEYS,
  CRITERIA_NAMES,
  IeltsError,
  MAX_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  TASKS,
  TASK_1,
  TASK_2,
  TASK_PARAGRAPH,
  CHART_TASKS,
  buildUserContent,
  cleanMarkup,
  countWords,
  createIeltsGrader,
  describeResult,
  formatIeltsFeedback,
  ieltsCacheKey,
  ieltsFeedbackParts,
  inputIdentity,
  normalizeForKey,
  normalizeImages,
  overallBand,
  parseDataUrl,
  parseIeltsResponse,
  pasteReceiptDocId,
  restoreLines,
  silentEdits,
  validateRequest,
};
