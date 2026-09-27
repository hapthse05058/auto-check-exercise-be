/**
 * IELTS Task 1 chart data: a vision model reads the chart image(s) ONCE into
 * text — a full data table, or the features of a map / the steps of a process
 * (prompt_ielts_chart.txt) — and the IELTS grader then works from that text.
 *
 * Why not let the grading model look at the image itself: cheap models see
 * the chart at low resolution and misread values that sit between gridlines,
 * then "correct" a student who had them right. A strong vision model reads
 * every value (tested 2026-09-27: gemini-3.8-flash 20/20 on a line graph), and
 * a whole class writes about the same chart — so it is read once, cached by
 * the images' hashes in `ieltsChartData`, and every student is graded against
 * the same numbers.
 *
 * The cache fills itself: the first essay about a new chart pays the read. A
 * new chart (other image bytes), another reader model or a bumped
 * IELTS_CHART_PROMPT_VERSION is a new key, so it is read again. To force a
 * re-read of one chart (a misread), delete its document.
 */
const crypto = require("crypto");

const { IeltsError } = require("./ieltsWriting.js");

const CHART_COLLECTION = "ieltsChartData";
/** One immediate retry when the model errors or answers nothing usable. */
const MAX_CHART_ATTEMPTS = 2;
const MIN_CHART_CHARS = 20;
const MAX_CHART_CHARS = 20000;

/** ieltsChartData document id: reader version + model + every image, in order. */
function chartKey({ version, model, images }) {
  const hashes = (images || []).map((image) => image.hash).join(",");
  return crypto
    .createHash("sha1")
    .update(`ielts-chart|${version}|${model}|${hashes}`)
    .digest("hex");
}

/** The reader's answer as clean text, or null when it cannot be used. */
function parseChartResponse(text) {
  let data = String(text ?? "").trim();
  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(data);
  if (fenced) data = fenced[1].trim();
  if (data.length < MIN_CHART_CHARS || data.length > MAX_CHART_CHARS) {
    return null;
  }
  return data;
}

/** The reader's user message: a short request, then the images in order. */
function buildChartContent(images) {
  return [
    {
      type: "text",
      text:
        images.length > 1
          ? `Đọc ${images.length} ảnh đề bài dưới đây (ghi rõ Ảnh 1, Ảnh 2… theo thứ tự).`
          : "Đọc ảnh đề bài dưới đây.",
    },
    ...images.map((image) => ({
      type: "image_url",
      image_url: {
        url: `data:${image.mime};base64,${image.buffer.toString("base64")}`,
      },
    })),
  ];
}

/**
 * @param deps.db          Firestore
 * @param deps.callModel   (instruction, content, model) => Promise<string>
 * @param deps.readPrompt  () => string (prompt_ielts_chart.txt)
 * @param deps.model       vision model id
 * @param deps.version     IELTS_CHART_PROMPT_VERSION
 */
function createChartReader({
  db,
  callModel,
  readPrompt,
  model,
  version,
  now = () => Date.now(),
  // eslint-disable-next-line no-console
  log = (...args) => console.log("[IELTS chart]", ...args),
}) {
  const collection = () => db.collection(CHART_COLLECTION);
  // A job grades several essays at once; those about the same chart share one
  // read instead of each paying for it.
  const inFlight = new Map();

  async function askModel(images, requestId) {
    const instruction = readPrompt();
    const content = buildChartContent(images);
    for (let attempt = 1; attempt <= MAX_CHART_ATTEMPTS; attempt++) {
      let text;
      try {
        text = await callModel(instruction, content, model);
      } catch (err) {
        log(
          `${requestId || "-"} attempt ${attempt}: model error ${err.message}`,
        );
        continue;
      }
      const data = parseChartResponse(text);
      if (data) return data;
      log(`${requestId || "-"} attempt ${attempt}: unusable answer`);
    }
    return null;
  }

  async function readUncached(id, images, { useCache, requestId }) {
    const ref = collection().doc(id);
    if (useCache) {
      const snap = await ref.get();
      const stored = snap.exists ? snap.data()?.data : null;
      if (stored) {
        ref
          .update({
            hitCount: (snap.data().hitCount || 0) + 1,
            lastHitAt: now(),
          })
          .catch(() => {});
        return { data: stored, cached: true };
      }
    }
    const data = await askModel(images, requestId);
    if (!data) throw new IeltsError(502, "ielts_chart_unreadable");
    await ref.set({
      data,
      model,
      version,
      imageHashes: images.map((image) => image.hash),
      hitCount: 0,
      createdAt: now(),
      requestId: requestId || null,
    });
    return { data, cached: false };
  }

  /**
   * The chart(s) of one Task 1 prompt as text.
   *
   * @param images  validated images ({mime, buffer, hash}), in prompt order
   * @returns {Promise<{data: string, cached: boolean}>}
   * @throws {IeltsError} 502 `ielts_chart_unreadable` when the model fails
   *   twice — nothing is cached then.
   */
  function read(images, { useCache = true, requestId } = {}) {
    const id = chartKey({ version, model, images });
    if (!inFlight.has(id)) {
      inFlight.set(
        id,
        readUncached(id, images, { useCache, requestId }).finally(() =>
          inFlight.delete(id),
        ),
      );
    }
    return inFlight.get(id);
  }

  return { read };
}

module.exports = {
  CHART_COLLECTION,
  MAX_CHART_ATTEMPTS,
  buildChartContent,
  chartKey,
  createChartReader,
  parseChartResponse,
};
