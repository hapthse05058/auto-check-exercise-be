/**
 * Grading of the two LMS exercises the Basic prompt does not cover:
 *
 *   word_order  "BÀI TẬP SẮP XẾP TỪ THÀNH CÂU ĐÚNG" — the student arranges the
 *               given words ("novels / He / loves / … / , so / he / .") into a
 *               sentence. Code checks the words are exactly the given ones
 *               (wordCheck); the model judges grammar and meaning.
 *   spelling    "BÀI TẬP CHÍNH TẢ" — a word turned into the form the group's
 *               rule asks for ("QUY TẮC 2: phụ âm + y → ies": story → stories).
 *
 * Kept apart from the Basic grader (server.js gradeItemsCached): its own two
 * short prompts, its own cache collection and keys — the doc flow, its prompt
 * and gradingCache are untouched.
 *
 * The model answers in the Basic table format (| STT | Đề | Bài làm | Chữa bài |,
 * "✅ Đúng" or a correction with **bold** fixes and a short reason), so the
 * same row checks (lib/basicRows.js) and isCorrectFeedback apply.
 */
const crypto = require("crypto");

const { itemId, matchGradedRows, parseGradedRows } = require("../basicRows.js");

const PROMPT_VERSION = "lms-extra-v1";
const CACHE = "lmsGradingCache";
const GROUP_SIZE = 20;
const CONCURRENCY = 3;

const TABLE_RULES = `
### OUTPUT (BẮT BUỘC)
Chỉ trả về MỘT bảng Markdown, đúng một dòng cho mỗi mục, 4 cột:
| STT | Đề | Bài làm | Chữa bài |
- Cột 1: [ID] y nguyên (Q1, Q2, …).
- Cột 3: chép lại [STUDENT_ANSWER].
- Cột 4: nếu ĐÚNG chỉ ghi đúng 1 cụm "✅ Đúng" (không giải thích). Nếu SAI: viết lại đáp án đúng, bọc phần sửa trong cặp dấu **, rồi giải thích ngắn gọn bằng tiếng Việt trong ngoặc đơn (tối đa 15 từ).
Không viết gì ngoài bảng. Không dùng dấu "|" trong nội dung ô.`;

const WORD_ORDER_PROMPT = `Bạn là giáo viên tiếng Anh chấm bài "Sắp xếp từ thành câu đúng" cho học viên người Việt mới học lại tiếng Anh.

Mỗi mục gồm:
[ID] mã mục; [CHỦ ĐIỂM] tiêu đề nhóm (nếu có); [CÁC TỪ ĐÃ CHO] các từ bị xáo trộn, ngăn bởi "/";
[KIỂM TRA TỪ] kết quả máy so các từ học viên dùng với các từ đã cho; [STUDENT_ANSWER] câu học viên viết.

### QUY TẮC CHẤM
- ĐÚNG khi câu học viên dùng đúng và đủ các từ đã cho (không thêm, không bớt, không sai chính tả), đúng ngữ pháp, đúng trật tự tự nhiên của tiếng Anh và có nghĩa hợp lý.
- Nếu có nhiều cách sắp xếp đều đúng ngữ pháp và hợp nghĩa thì đều chấp nhận.
- Không tính lỗi: viết hoa/viết thường, dấu chấm cuối câu, khoảng trắng.
- Nếu [KIỂM TRA TỪ] báo thiếu, thừa hoặc sai từ thì câu đó SAI: viết lại câu đúng chỉ bằng các từ đã cho và nêu từ bị thiếu/thừa/sai chính tả.
- Dấu phẩy đi kèm từ đã cho (ví dụ ", so" hoặc "milk,") phải đặt đúng chỗ; thiếu dấu phẩy trước liên từ trong câu ghép (FANBOYS) là SAI.

Ví dụ cột 4 khi sai:
She drinks milk, for it is **healthy**. (Sai chính tả: healthy.)
I like coffee**,** but she likes tea. (Câu ghép cần dấu phẩy trước but.)
${TABLE_RULES}`;

const SPELLING_PROMPT = `Bạn là giáo viên tiếng Anh chấm bài "Chính tả" cho học viên người Việt mới học lại tiếng Anh: chuyển một từ sang dạng mà quy tắc của nhóm yêu cầu (thêm s/es, số nhiều bất quy tắc, so sánh hơn/so sánh nhất, …).

Mỗi mục gồm:
[ID] mã mục; [QUY TẮC] tiêu đề của nhóm câu hỏi (quy tắc, ví dụ và yêu cầu); [TỪ GỐC] từ đề bài cho; [STUDENT_ANSWER] dạng từ học viên viết.

### QUY TẮC CHẤM
- ĐÚNG khi học viên viết đúng dạng từ theo yêu cầu của nhóm và đúng chính tả. Không tính lỗi viết hoa chữ cái đầu và dấu chấm cuối.
- Nếu đề yêu cầu nhiều dạng (ví dụ so sánh hơn và so sánh nhất) thì phải đúng tất cả các dạng.
- Nếu học viên ghi nhiều đáp án cho một từ (ví dụ "Mice / Mouses") mà có một đáp án sai thì SAI.
- Từ có hai dạng số nhiều đều được chấp nhận trong từ điển (ví dụ zeros/zeroes) thì chấp nhận cả hai.

Ví dụ cột 4 khi sai:
**countries** (Phụ âm + y → bỏ y thêm ies.)
**mice** (Mouse là danh từ bất quy tắc: mouse → mice.)
${TABLE_RULES}`;

/** Lower-case word tokens (letters/digits/apostrophes). */
function tokens(text) {
  return String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .split(/[^\p{L}\p{N}\p{M}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/**
 * Compares the student's words with the given ones as multisets.
 * @returns {{ok: boolean, missing: string[], extra: string[]}}
 */
function wordCheck(given, answer) {
  const want = new Map();
  for (const w of tokens(given)) want.set(w, (want.get(w) || 0) + 1);
  const extra = [];
  for (const w of tokens(answer)) {
    if (want.get(w) > 0) want.set(w, want.get(w) - 1);
    else extra.push(w);
  }
  const missing = [];
  for (const [w, n] of want) for (let i = 0; i < n; i++) missing.push(w);
  return { ok: !missing.length && !extra.length, missing, extra };
}

function describeWordCheck(check) {
  if (check.ok) return "Học viên dùng đúng và đủ các từ đã cho.";
  const parts = [];
  if (check.missing.length)
    parts.push(`thiếu/sai: ${check.missing.join(", ")}`);
  if (check.extra.length) parts.push(`thừa/sai: ${check.extra.join(", ")}`);
  return `KHÔNG khớp các từ đã cho (${parts.join("; ")}).`;
}

const oneLine = (text) =>
  String(text ?? "")
    .replace(/\s*\n\s*/g, " / ")
    .trim();

function buildInput(kind, group) {
  const blocks = group.map((item, i) => {
    const lines = [`[ID]: ${itemId(i)}`];
    if (kind === "word_order") {
      if (item.context) lines.push(`[CHỦ ĐIỂM]: ${oneLine(item.context)}`);
      lines.push(`[CÁC TỪ ĐÃ CHO]: ${oneLine(item.question)}`);
      lines.push(
        `[KIỂM TRA TỪ]: ${describeWordCheck(wordCheck(item.question, item.answer))}`,
      );
    } else {
      if (item.context) lines.push(`[QUY TẮC]: ${oneLine(item.context)}`);
      lines.push(`[TỪ GỐC]: ${oneLine(item.question)}`);
    }
    lines.push(`[STUDENT_ANSWER]: ${oneLine(item.answer)}`);
    return `\n${lines.join("\n")}`;
  });
  return (
    `DATASET TO EVALUATE:\`\`\`\n${blocks.join("\n")}\n\n\`\`\`` +
    "[CRITICAL RULE]: Output a single Markdown table with exactly one row per item. " +
    "Column 1 must be the item's [ID] exactly as given and column 3 must copy its [STUDENT_ANSWER]."
  );
}

const normalize = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Cache id: prompt version + kind + rule context + question + answer. */
function cacheId(item) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        PROMPT_VERSION,
        item.kind,
        normalize(item.context),
        normalize(item.question),
        // Case is not graded, but spelling is: keep every letter.
        normalize(item.answer),
      ]),
    )
    .digest("hex");
}

/**
 * A word-order answer that does not use the given words can never be right,
 * whatever the model says.
 */
function enforceWordCheck(item, feedback, isCorrect) {
  if (item.kind !== "word_order" || !isCorrect(feedback)) return feedback;
  const check = wordCheck(item.question, item.answer);
  if (check.ok) return feedback;
  const parts = [];
  if (check.missing.length) parts.push(`thiếu ${check.missing.join(", ")}`);
  if (check.extra.length) parts.push(`thừa/sai ${check.extra.join(", ")}`);
  return `${oneLine(item.answer)}\n(Chưa dùng đúng các từ đã cho: ${parts.join("; ")}.)`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * @param deps.callAi   (systemPrompt, userInput) => Promise<string>
 * @param deps.db       Firestore (cache); null disables the cache
 * @param deps.isCorrectFeedback  lib/doc/docParser.js isCorrectFeedback
 * @param deps.now      () => ms
 */
function createLmsExtraGrader({
  callAi,
  db = null,
  isCorrectFeedback,
  now = Date.now,
}) {
  const prompts = { word_order: WORD_ORDER_PROMPT, spelling: SPELLING_PROMPT };

  async function readCache(ids) {
    if (!db || !ids.length) return new Map();
    const snaps = await db.getAll(
      ...ids.map((id) => db.collection(CACHE).doc(id)),
    );
    const found = new Map();
    for (const s of snaps)
      if (s.exists && s.data().feedback) found.set(s.id, s.data().feedback);
    return found;
  }

  async function writeCache(entries) {
    if (!db || !entries.length) return;
    const batch = db.batch();
    for (const { id, item, feedback } of entries) {
      batch.set(db.collection(CACHE).doc(id), {
        promptVersion: PROMPT_VERSION,
        kind: item.kind,
        context: item.context || "",
        question: item.question,
        answer: item.answer,
        feedback,
        createdAt: now(),
      });
    }
    await batch.commit();
  }

  /** One group of one kind → feedback per item (null where untrusted). */
  async function gradeGroup(kind, group) {
    const text = await callAi(prompts[kind], buildInput(kind, group));
    const { feedbacks } = matchGradedRows(group, parseGradedRows(text), {
      checkFit: false,
    });
    return feedbacks;
  }

  /**
   * @param items [{kind: "word_order"|"spelling", question, answer, context}]
   * @returns Promise<Array<string|null>> feedback aligned with `items`
   */
  async function grade(items) {
    const out = new Array(items.length).fill(null);
    const ids = items.map(cacheId);
    const cached = await readCache([...new Set(ids)]);
    // Unique uncached items per kind.
    const pending = new Map(); // id -> {item, indexes}
    items.forEach((item, i) => {
      if (cached.has(ids[i])) {
        out[i] = cached.get(ids[i]);
        return;
      }
      if (!pending.has(ids[i])) pending.set(ids[i], { item, indexes: [] });
      pending.get(ids[i]).indexes.push(i);
    });
    const groups = [];
    for (const kind of ["word_order", "spelling"]) {
      const list = [...pending.entries()].filter(
        ([, p]) => p.item.kind === kind,
      );
      for (let i = 0; i < list.length; i += GROUP_SIZE) {
        groups.push({ kind, entries: list.slice(i, i + GROUP_SIZE) });
      }
    }
    const fresh = [];
    const retry = [];
    await mapLimit(groups, CONCURRENCY, async ({ kind, entries }) => {
      const feedbacks = await gradeGroup(
        kind,
        entries.map(([, p]) => p.item),
      );
      entries.forEach(([id, p], j) => {
        if (feedbacks[j])
          fresh.push({ id, item: p.item, feedback: feedbacks[j] });
        else retry.push([id, p]);
      });
    });
    // An item the model mixed up or dropped is graded again on its own.
    await mapLimit(retry, CONCURRENCY, async ([id, p]) => {
      const [feedback] = await gradeGroup(p.item.kind, [p.item]);
      if (feedback) fresh.push({ id, item: p.item, feedback });
    });
    for (const entry of fresh) {
      entry.feedback = enforceWordCheck(
        entry.item,
        entry.feedback,
        isCorrectFeedback,
      );
    }
    await writeCache(fresh).catch((err) =>
      console.error("[LMS-EXTRA] cache write failed:", err.message),
    );
    const byId = new Map(fresh.map((e) => [e.id, e.feedback]));
    for (const [id, p] of pending) {
      for (const i of p.indexes) out[i] = byId.get(id) ?? null;
    }
    return out;
  }

  return { grade };
}

module.exports = {
  PROMPT_VERSION,
  SPELLING_PROMPT,
  WORD_ORDER_PROMPT,
  buildInput,
  createLmsExtraGrader,
  wordCheck,
};
