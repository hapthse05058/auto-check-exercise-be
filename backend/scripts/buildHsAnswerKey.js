/**
 * Builds the HS answer key, lib/hs/hsAnswerKey.json, that lib/hsGrading.js
 * reads: one entry per item of the HS form (lib/doc/hsTemplate.js), keyed by
 * the item's canonical key "{lessonId}|{exerciseId}|{normalized prompt}".
 *
 *   {entries: {[key]: {answers: string[], source, note?}}}
 *   source: "ai_draft"            drafted by the model — a HINT only
 *           "ai_draft_approved"   drafted, then approved by a person
 *           "teacher_verified"    taken from teachers' ticks in real docs
 * Only approved and teacher-verified answers decide a blank on their own
 * (no model call); a plain draft is only shown to the model as a reference.
 * Several blanks in one item are one answer "fill1 | fill2".
 *
 * Steps (from backend/):
 *   node scripts/buildHsAnswerKey.js draft            model drafts → .draft.json
 *   node scripts/buildHsAnswerKey.js b3 <dir>         Buổi 03 listening from the
 *        teachers' ✅ in graded docs (Docs API JSON, .json or .json.gz) — the
 *        model can not hear the audio, so these are never drafted
 *   node scripts/buildHsAnswerKey.js export           → hs-answer-key.csv (review)
 *   node scripts/buildHsAnswerKey.js import <csv>     reviewed CSV → hsAnswerKey.json
 *   node scripts/buildHsAnswerKey.js check            validate hsAnswerKey.json
 *
 * In the CSV, put "x" in the `approved` column of every row checked (edit
 * `answers` first if needed; separate alternatives with " || ").
 * `import` and `check` FAIL on: a key the form does not have, two keys equal
 * after normalisation, an item of the form without an entry, a listening item
 * without teacher-verified answers.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DIR = path.join(__dirname, "..", "lib", "hs");
const KEY_FILE = path.join(DIR, "hsAnswerKey.json");
const DRAFT_FILE = path.join(DIR, "hsAnswerKey.draft.json");
const CSV_FILE = path.join(__dirname, "..", "hs-answer-key.csv");
const SOURCES = new Set(["ai_draft", "ai_draft_approved", "teacher_verified"]);
const LISTENING = "listening";

async function formItems() {
  const { HS_LESSONS } = await import("../lib/doc/hsTemplate.js");
  const out = [];
  for (const lesson of HS_LESSONS) {
    for (const ex of lesson.exercises) {
      for (const item of ex.items) {
        out.push({
          key: item.key,
          lessonId: lesson.id,
          exerciseId: ex.id,
          n: item.n,
          kind: item.kind,
          instruction: ex.instruction,
          prompt: item.prompt,
          ...(item.hint ? { hint: item.hint } : {}),
          ...(item.underlined ? { underlined: item.underlined } : {}),
          ...(item.labels ? { labels: item.labels } : {}),
          ...(item.options ? { options: item.options } : {}),
          ...(item.slot !== undefined ? { slot: item.slot } : {}),
        });
      }
    }
  }
  return out;
}

const readJson = (file, fallback) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Same normalisation hsDoc uses for keys (lower case, quotes, spaces). */
const normalizeKey = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, " ")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Checks a key against the form. Returns the list of problems (empty = ok).
 */
function validateKey(key, items) {
  const problems = [];
  const byKey = new Map(items.map((i) => [i.key, i]));
  const seen = new Map();
  for (const [k, entry] of Object.entries(key.entries || {})) {
    if (!byKey.has(k)) problems.push(`unknown key: ${k}`);
    const norm = normalizeKey(k);
    if (seen.has(norm))
      problems.push(`duplicate after normalisation: ${k} ~ ${seen.get(norm)}`);
    seen.set(norm, k);
    if (!SOURCES.has(entry.source))
      problems.push(`bad source ${entry.source}: ${k}`);
    if (!Array.isArray(entry.answers) || !entry.answers.length) {
      problems.push(`no answers: ${k}`);
    }
  }
  for (const item of items) {
    const entry = key.entries?.[item.key];
    if (!entry) {
      problems.push(`missing entry: ${item.key}`);
    } else if (item.kind === LISTENING && entry.source !== "teacher_verified") {
      problems.push(`listening needs teacher-verified answers: ${item.key}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// draft — the model's answers, a hint until a person approves them
// ---------------------------------------------------------------------------

const DRAFT_PROMPT = `You write the ANSWER KEY of an English homework form for Vietnamese pupils (primary / lower secondary). For every item give the correct answer(s).
Return ONLY JSON: {"items":[{"id":"1","answers":["..."],"note":"..."}]} — every id exactly once.
- "answers": the expected answer first, then other fully correct alternatives (contractions: "doesn't have" AND "does not have"; other correct word orders). Short answers only:
  - kind "blank": the words for the blanks only, several blanks joined with " | " (e.g. "doesn't talk | is cleaning"); no brackets, no full sentence.
  - kind "passage": the word(s) for blank number "blank" of the line (use the word bank of the instruction if there is one).
  - kind "line": the complete answer sentence / answer. With "underlined": the Wh-question asking about exactly that part (without it).
  - kind "vi_en": the English translation (use the hint's words and tense).
  - kind "svo": "S: … – V: … – O: …".
  - kind "grid", "sort": the content of that cell / column.
  - kind "tense": the translation, then " – " and the tense column.
  - kind "choose": the right option.
  - kind "underline_translate": "Nc: …; Dịch: …".
  - kind "blank_reason": the verb form(s), then " – " and the reason in Vietnamese.
- "note": optional, Vietnamese, only when something is ambiguous.`;

async function draft() {
  const OpenAI = require("openai");
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
  const apiKey = process.env.HS_AI_API_KEY || process.env.AI_API_KEY;
  const baseURL =
    process.env.HS_AI_BASE_URL ||
    process.env.AI_BASE_URL ||
    "https://api.deepseek.com";
  const model =
    process.env.HS_AI_MODEL || process.env.AI_MODEL || "deepseek-chat";
  if (!apiKey) throw new Error("HS_AI_API_KEY / AI_API_KEY not set");
  const client = new OpenAI({ apiKey, baseURL });

  const items = (await formItems()).filter((i) => i.kind !== LISTENING);
  const out = readJson(DRAFT_FILE, { entries: {} });
  const groups = new Map();
  for (const item of items) {
    if (out.entries[item.key]) continue; // resumable
    const g = `${item.lessonId}|${item.exerciseId}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }
  // Several exercises at once: a thinking model takes a while per call.
  const queue = [...groups.entries()];
  const worker = async () => {
    while (queue.length) {
      const [g, list] = queue.shift();
      for (let i = 0; i < list.length; i += 20) {
        const batch = list.slice(i, i + 20);
        const content = JSON.stringify({
          instruction: batch[0].instruction,
          items: batch.map((it, n) => ({
            id: String(n + 1),
            kind: it.kind,
            prompt: it.prompt,
            ...(it.hint ? { hint: it.hint } : {}),
            ...(it.underlined ? { underlined: it.underlined } : {}),
            ...(it.labels ? { labels: it.labels } : {}),
            ...(it.options ? { options: it.options } : {}),
            ...(it.slot !== undefined ? { blank: it.slot + 1 } : {}),
          })),
        });
        let parsed = null;
        for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
          const res = await client.chat.completions.create({
            model,
            messages: [
              { role: "system", content: DRAFT_PROMPT },
              { role: "user", content },
            ],
            temperature: 0,
            max_tokens: 8000,
          });
          const text = res.choices?.[0]?.message?.content || "";
          try {
            const json = JSON.parse(
              text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
            );
            const ids = new Set((json.items || []).map((x) => String(x.id)));
            if (
              ids.size === batch.length &&
              batch.every((_, n) => ids.has(String(n + 1)))
            )
              parsed = json;
          } catch {
            // retried below
          }
        }
        if (!parsed) {
          console.warn(
            `  ! ${g} items ${i + 1}-${i + batch.length}: no usable answer, skipped`,
          );
          continue;
        }
        for (const x of parsed.items) {
          const item = batch[Number(x.id) - 1];
          const answers = (x.answers || [])
            .map((a) => String(a).trim())
            .filter(Boolean);
          if (!answers.length) continue;
          out.entries[item.key] = {
            answers,
            source: "ai_draft",
            ...(x.note ? { note: String(x.note) } : {}),
          };
        }
        writeJson(DRAFT_FILE, out);
        console.log(
          `  ${g}: ${Object.keys(out.entries).length} drafted so far`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(
    `\nDraft: ${Object.keys(out.entries).length}/${items.length} items → ${path.relative(process.cwd(), DRAFT_FILE)}`,
  );
}

// ---------------------------------------------------------------------------
// b3 — listening answers from the teachers' ticks
// ---------------------------------------------------------------------------

const readDoc = (file) =>
  JSON.parse(
    file.endsWith(".gz")
      ? zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")
      : fs.readFileSync(file, "utf8"),
  );

/**
 * Per listening item, the answers teachers ticked (✅) in graded docs, with
 * how many docs ticked each. Only an answer ticked in 2+ docs is kept.
 */
async function listeningFromDocs(files) {
  const hs = await import("../lib/doc/hsDoc.js");
  const votes = new Map();
  for (const file of files) {
    const doc = readDoc(file);
    for (const tab of doc.tabs || []) {
      const { items } = hs.collectHsItems(tab, {
        lessonName: tab.tabProperties.title,
      });
      for (const item of items) {
        if (item.kind !== LISTENING || typeof item.answer !== "string")
          continue;
        if (!/✅/u.test(item.answer)) continue;
        const word = item.answer
          .replace(/[✅❌]/gu, "")
          .trim()
          .toLowerCase();
        if (!word) continue;
        if (!votes.has(item.key)) votes.set(item.key, new Map());
        const v = votes.get(item.key);
        v.set(word, (v.get(word) || 0) + 1);
      }
    }
  }
  const out = {};
  for (const [key, v] of votes) {
    const answers = [...v.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([w]) => w);
    if (answers.length) {
      out[key] = {
        answers,
        source: "teacher_verified",
        note: `ticked ✅ by teachers in ${[...v.values()].reduce((a, b) => a + b, 0)} docs`,
      };
    }
  }
  return out;
}

async function b3(dir) {
  if (!dir) throw new Error("usage: b3 <dir of graded docs>");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.json(\.gz)?$/.test(f))
    .map((f) => path.join(dir, f));
  const found = await listeningFromDocs(files);
  const out = readJson(DRAFT_FILE, { entries: {} });
  Object.assign(out.entries, found);
  writeJson(DRAFT_FILE, out);
  const want = (await formItems()).filter((i) => i.kind === LISTENING);
  for (const item of want) {
    const e = found[item.key];
    console.log(
      `  ${e ? "✓" : "✗ MISSING"} ${item.prompt.slice(0, 50)} [${item.slot}] → ${e ? e.answers.join(" || ") : ""}`,
    );
  }
  console.log(
    `\nListening: ${Object.keys(found).length}/${want.length} from ${files.length} docs.`,
  );
}

// ---------------------------------------------------------------------------
// export / import — the human review
// ---------------------------------------------------------------------------

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLUMNS = [
  "key",
  "lesson",
  "exercise",
  "n",
  "kind",
  "prompt",
  "hint",
  "answers",
  "source",
  "note",
  "approved",
];

async function exportCsv() {
  const items = await formItems();
  const current = readJson(KEY_FILE, { entries: {} });
  const draftKey = readJson(DRAFT_FILE, { entries: {} });
  const lines = [COLUMNS.join(",")];
  for (const item of items) {
    const entry =
      current.entries[item.key] || draftKey.entries[item.key] || null;
    const approved = entry && entry.source !== "ai_draft" ? "x" : "";
    lines.push(
      [
        item.key,
        item.lessonId,
        item.exerciseId,
        item.n,
        item.kind,
        item.prompt,
        item.hint || (item.underlined ? `gạch chân: ${item.underlined}` : ""),
        entry ? entry.answers.join(" || ") : "",
        entry ? entry.source : "",
        entry?.note || "",
        approved,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // BOM: Excel / Google Sheets then read the Vietnamese correctly.
  fs.writeFileSync(CSV_FILE, `\uFEFF${lines.join("\n")}\n`);
  console.log(
    `${items.length} rows → ${path.relative(process.cwd(), CSV_FILE)}`,
  );
}

async function importCsv(file) {
  const text = fs.readFileSync(file || CSV_FILE, "utf8").replace(/^\uFEFF/, "");
  const [head, ...rows] = parseCsv(text);
  const col = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  for (const c of ["key", "answers", "source", "approved"]) {
    if (col[c] === undefined) throw new Error(`CSV has no "${c}" column`);
  }
  const entries = {};
  for (const r of rows) {
    const key = r[col.key];
    const answers = String(r[col.answers] || "")
      .split("||")
      .map((a) => a.trim())
      .filter(Boolean);
    if (!answers.length) continue;
    const approved = /^\s*(x|1|yes|true|ok)\s*$/i.test(r[col.approved] || "");
    let source = String(r[col.source] || "").trim() || "ai_draft";
    if (source === "ai_draft" && approved) source = "ai_draft_approved";
    if (source !== "ai_draft" && !approved && source !== "teacher_verified")
      source = "ai_draft";
    const note = col.note !== undefined ? String(r[col.note] || "").trim() : "";
    entries[key] = { answers, source, ...(note ? { note } : {}) };
  }
  const key = { entries };
  const problems = validateKey(key, await formItems());
  if (problems.length) {
    console.error(
      `✗ ${problems.length} problem(s):\n  ${problems.slice(0, 40).join("\n  ")}`,
    );
    process.exit(1);
  }
  writeJson(KEY_FILE, key);
  const counts = {};
  for (const e of Object.values(entries))
    counts[e.source] = (counts[e.source] || 0) + 1;
  console.log(
    `✓ ${Object.keys(entries).length} entries → ${path.relative(process.cwd(), KEY_FILE)}`,
    counts,
  );
}

async function check() {
  const key = readJson(KEY_FILE, null);
  if (!key) {
    console.error(
      `✗ ${path.relative(process.cwd(), KEY_FILE)} does not exist yet`,
    );
    process.exit(1);
  }
  const problems = validateKey(key, await formItems());
  if (problems.length) {
    console.error(
      `✗ ${problems.length} problem(s):\n  ${problems.slice(0, 40).join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(`✓ ${Object.keys(key.entries).length} entries, valid`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "draft") return draft();
  if (cmd === "b3") return b3(arg);
  if (cmd === "export") return exportCsv();
  if (cmd === "import") return importCsv(arg);
  if (cmd === "check") return check();
  console.error(
    "usage: buildHsAnswerKey.js draft | b3 <dir> | export | import [csv] | check",
  );
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  formItems,
  listeningFromDocs,
  normalizeKey,
  parseCsv,
  validateKey,
};
