/**
 * IELTS short-sentence exercises ("Viết câu mô tả …", "Viết luận cứ … bằng
 * tiếng Việt & tiếng Anh"): one table of a student's doc graded in one model
 * call, one comment per row — "✅" for a right sentence, the sentence
 * corrected in place otherwise (lib/doc/ieltsDoc.js, layout "sentences",
 * writes each into the row's "GV chữa/nhận xét" cell).
 *
 * Kept apart from the essays (lib/ieltsWriting.js) the same way the essays
 * are kept apart from Basic: its own prompt (prompt_ielts_sentences.txt), its
 * own prompt version and its own cache collection. It shares the essays'
 * model, chart reader and image rules.
 */
const crypto = require("crypto");

const {
  IeltsError,
  MAX_ATTEMPTS,
  cleanMarkup,
  normalizeForKey,
  normalizeImages,
  silentEdits,
} = require("./ieltsWriting.js");

const CACHE_COLLECTION = "ieltsSentenceCache";

const MAX_ROWS = 40;
const MAX_PROMPT_CHARS = 5000;
const MAX_CELL_CHARS = 3000;
const MAX_COLUMNS = 6;
const VERDICTS = ["correct", "fix", "blank"];
/** Attempts while an answer still drops the student's words unmarked. */
const MAX_REPAIR_ATTEMPTS = 3;
const CORRECT_MARK = "✅";

const sha1 = (data) => crypto.createHash("sha1").update(data).digest("hex");

/**
 * Checks and normalises one table.
 *
 * @param {{prompt, columns: string[], rows: Array<{row: number,
 *   cells: string[]}>, images?}} input
 * @returns {{prompt, columns, rows, images: Array<{mime, buffer, hash}>}}
 * @throws {IeltsError} 400
 */
function validateSentenceRequest(input) {
  const body = input && typeof input === "object" ? input : {};
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new IeltsError(400, "prompt_required");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new IeltsError(400, "prompt_too_long", { max: MAX_PROMPT_CHARS });
  }
  const columns = Array.isArray(body.columns)
    ? body.columns.map((c) => String(c ?? "").trim())
    : [];
  if (!columns.length || columns.length > MAX_COLUMNS) {
    throw new IeltsError(400, "invalid_columns");
  }
  if (!Array.isArray(body.rows) || !body.rows.length) {
    throw new IeltsError(400, "essay_required");
  }
  if (body.rows.length > MAX_ROWS) {
    throw new IeltsError(400, "too_many_rows", { max: MAX_ROWS });
  }
  const seen = new Set();
  const rows = body.rows.map((r) => {
    const row = Number(r?.row);
    if (!Number.isInteger(row) || row < 1 || seen.has(row)) {
      throw new IeltsError(400, "invalid_rows");
    }
    seen.add(row);
    const cells = (Array.isArray(r.cells) ? r.cells : []).map((c) =>
      String(c ?? "").trim(),
    );
    if (cells.length !== columns.length) {
      throw new IeltsError(400, "invalid_rows");
    }
    if (cells.some((c) => c.length > MAX_CELL_CHARS)) {
      throw new IeltsError(400, "essay_too_long", { max: MAX_CELL_CHARS });
    }
    return { row, cells };
  });
  const raw =
    body.images === undefined || body.images === null ? [] : body.images;
  return { prompt, columns, rows, images: normalizeImages(raw) };
}

/** ieltsSentenceCache document id: everything the answer depends on. */
function sentenceCacheKey({
  promptVersion,
  model,
  chartData = null,
  ...input
}) {
  const identity = JSON.stringify([
    normalizeForKey(input.prompt),
    input.columns.map(normalizeForKey),
    input.rows.map((r) => [r.row, r.cells.map(normalizeForKey)]),
    (input.images || []).map((image) => image.hash),
    chartData ? normalizeForKey(chartData) : null,
  ]);
  return sha1(`ielts-sentences|${promptVersion}|${model}|${identity}`);
}

/** The user message: labelled text, then the chart images when not read. */
function buildSentenceContent({
  prompt,
  columns,
  rows,
  images,
  chartData = null,
}) {
  const chart = chartData
    ? `[DỮ LIỆU BIỂU ĐỒ] (đã trích từ ảnh đề bài):\n${chartData}\n\n`
    : "";
  const lines = rows.map(
    (r) =>
      `Dòng ${r.row}: ` +
      r.cells
        .map((cell, i) => `${columns[i]}: ${cell.replace(/\s*\n\s*/g, " ")}`)
        .join(" | "),
  );
  const text =
    `[ĐỀ BÀI]:\n${prompt}\n\n` +
    chart +
    `[CÁC CỘT]: ${columns.join(" | ")}\n\n` +
    `[CÁC DÒNG]:\n${lines.join("\n")}`;
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
 * The model's answer as {row → {verdict, feedback}}, or null when unusable:
 * not JSON, a verdict out of the set, a "fix" without text, a row asked
 * twice or never asked, or a row asked for and missing.
 */
function parseSentenceResponse(text, askedRows) {
  let raw = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
  if (fenced) raw = fenced[1];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.rows)) return null;
  const asked = new Set(askedRows);
  const out = new Map();
  for (const item of data.rows) {
    const row = Number(item?.row);
    if (!asked.has(row) || out.has(row)) return null;
    const verdict = item.verdict;
    if (!VERDICTS.includes(verdict)) return null;
    const feedback = cleanMarkup(String(item.feedback ?? "")).trim();
    if (verdict === "fix" && (!feedback || feedback === CORRECT_MARK)) {
      return null;
    }
    out.set(row, {
      verdict,
      feedback:
        verdict === "correct"
          ? CORRECT_MARK
          : verdict === "blank"
            ? ""
            : feedback,
    });
  }
  if (out.size !== asked.size) return null;
  return out;
}

/** "Sđơn vị… + V + adv: The fruit …" → "The fruit …" (a short label off). */
const withoutLabel = (text) =>
  String(text ?? "")
    .replace(/^[^:\n]{1,80}:/u, "")
    .trim();

/**
 * The student's words a "fix" comment changed or dropped without marking
 * them (lib/ieltsWriting.js silentEdits), per row. Which cells are the
 * student's is not known — a row also holds the teacher's labels, hints and
 * given problems — so a cell counts only when the comment clearly copies it
 * (most of its words are there); a Vietnamese cell the comment does not
 * repeat, or a hint, is left out.
 *
 * @returns {Array<{row, words, context}>}
 */
function sentenceSilentEdits(rows, results) {
  const out = [];
  for (const { row, cells } of rows) {
    const result = results.get(row);
    if (!result || result.verdict !== "fix") continue;
    for (const [i, cell] of cells.entries()) {
      // A first column without "label:" is the teacher's ("Chủ ngữ vật").
      if (i === 0 && cells.length > 1 && !cell.includes(":")) continue;
      const text = withoutLabel(cell);
      const total = text.split(/\s+/).filter(Boolean).length;
      if (total < 4) continue;
      const edits = silentEdits(text, result.feedback);
      const lost = edits.reduce((n, e) => n + e.words.split(" ").length, 0);
      if (!lost || lost > total / 2) continue;
      for (const e of edits) out.push({ row, ...e });
    }
  }
  return out;
}

/** The note added to a retry after silent edits. */
function sentenceReminder(edits) {
  const list = edits
    .slice(0, 12)
    .map((e) => `- Dòng ${e.row}: "${e.words}" (trong: …${e.context}…)`)
    .join("\n");
  return (
    `[KIỂM TRA LẠI] Ở lần trả lời trước, phần chữa đã tự đổi hoặc bỏ những chữ ` +
    `sau của học viên mà KHÔNG đánh dấu:\n${list}\n` +
    `Chép lại nguyên văn câu học viên: chỗ nào cần sửa thì in đậm chữ gốc rồi ` +
    `"→ cách sửa", chỗ nào đúng thì chép y nguyên. Hãy trả lời lại TOÀN BỘ object JSON.`
  );
}

/**
 * @param deps.db            Firestore
 * @param deps.callModel     (instruction, content, model) => Promise<string>
 * @param deps.readPrompt    () => string (prompt_ielts_sentences.txt)
 * @param deps.model         model id (the essays' IELTS_AI_MODEL)
 * @param deps.promptVersion IELTS_SENTENCE_PROMPT_VERSION
 * @param deps.readChart     optional (images, {useCache, requestId}) =>
 *   Promise<{data}> — the essays' chart reader.
 */
function createIeltsSentenceGrader({
  db,
  callModel,
  readPrompt,
  model,
  promptVersion,
  readChart = null,
  now = () => Date.now(),
  // eslint-disable-next-line no-console
  log = (...args) => console.log("[IELTS-SENTENCES]", ...args),
}) {
  const cache = () => db.collection(CACHE_COLLECTION);

  /**
   * Grades one validated table (validateSentenceRequest).
   *
   * @returns {Promise<{results: Map<number, {verdict, feedback}>,
   *   cached: boolean}>}
   * @throws {IeltsError} 502 ielts_ai_invalid after MAX_ATTEMPTS bad answers
   */
  async function grade(input, { useCache = true, requestId } = {}) {
    const chartData =
      readChart && input.images.length
        ? (await readChart(input.images, { useCache, requestId })).data
        : null;
    const ref = cache().doc(
      sentenceCacheKey({ promptVersion, model, chartData, ...input }),
    );
    if (useCache) {
      const snap = await ref.get();
      const stored = snap.exists ? snap.data()?.results : null;
      if (Array.isArray(stored)) {
        ref
          .update({
            hitCount: (snap.data().hitCount || 0) + 1,
            lastHitAt: now(),
          })
          .catch(() => {});
        return {
          results: new Map(
            stored.map((r) => [
              r.row,
              { verdict: r.verdict, feedback: r.feedback },
            ]),
          ),
          cached: true,
        };
      }
    }

    const instruction = readPrompt();
    const content = buildSentenceContent({ ...input, chartData });
    const askedRows = input.rows.map((r) => r.row);
    // Like the essays: retried once when unusable; when an answer edits the
    // student's words silently, asked again with those words named, and the
    // answer losing the fewest wins.
    let best = null;
    let reminder = null;
    for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      if (attempt > MAX_ATTEMPTS && !best?.lost) break;
      let parsed = null;
      try {
        parsed = parseSentenceResponse(
          await callModel(
            instruction,
            reminder ? [...content, { type: "text", text: reminder }] : content,
            model,
          ),
          askedRows,
        );
        if (!parsed)
          log(`${requestId || "-"} attempt ${attempt}: invalid response`);
      } catch (err) {
        log(
          `${requestId || "-"} attempt ${attempt}: model error ${err.message}`,
        );
      }
      if (!parsed) continue;
      const edits = sentenceSilentEdits(input.rows, parsed);
      if (!best || edits.length < best.lost)
        best = { results: parsed, lost: edits.length };
      if (!edits.length) break;
      log(
        `${requestId || "-"} attempt ${attempt}: ${edits.length} silent edit(s): ` +
          edits.map((e) => `${e.row}:${e.words}`).join(" | "),
      );
      reminder = sentenceReminder(edits);
    }
    if (!best) throw new IeltsError(502, "ielts_ai_invalid");
    const { results } = best;

    await ref.set({
      prompt: input.prompt,
      columns: input.columns,
      rows: input.rows,
      imageHashes: input.images.map((image) => image.hash),
      chartData,
      results: [...results].map(([row, r]) => ({ row, ...r })),
      model,
      promptVersion,
      hitCount: 0,
      createdAt: now(),
    });
    return { results, cached: false };
  }

  return { grade };
}

module.exports = {
  CACHE_COLLECTION,
  CORRECT_MARK,
  MAX_ROWS,
  buildSentenceContent,
  createIeltsSentenceGrader,
  parseSentenceResponse,
  sentenceCacheKey,
  sentenceSilentEdits,
  validateSentenceRequest,
};
