// So sánh prompt CŨ (prompt_and_instruction_for_responses_api_2.txt, gửi tài
// liệu của mọi buổi) với prompt MỚI (core + tài liệu đúng buổi) trên cùng một
// bộ câu lấy từ gradingCache.
//
// Đây là chỗ duy nhất trả lời được hai câu hỏi của đợt tối ưu này:
//   1. Cắt được bao nhiêu input token (và bao nhiêu phần được trả giá cache).
//   2. Prompt mới có chấm khác prompt cũ ở chỗ nào — nhất là ĐÚNG/SAI đảo
//      chiều, thứ duy nhất học viên thật sự nhìn thấy.
//
// Script KHÔNG ghi gì vào Firestore: chỉ đọc mẫu và gọi AI.
//
//   node scripts/compareGradingPrompts.js --limit=60 --dry-run
//   node scripts/compareGradingPrompts.js --limit=60
//   node scripts/compareGradingPrompts.js --limit=60 --lesson=lesson15
//   node scripts/compareGradingPrompts.js --limit=60 --out=ket-qua.json
const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");

const { getDb } = require("../lib/firestore.js");
const {
  createInstructionBuilder,
} = require("../lib/buildGradingInstruction.js");
const { TASK_ACTIVE_PASSIVE } = require("../lib/gradingKey.js");
const { parseGradedTable } = require("../lib/parseGradedTable.js");

const GROUP_SIZE = 15; // Giống server: so sánh phải cùng kích thước group.

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = args.includes("--dry-run");
const limit = Number(flag("limit", 60));
const onlyLesson = flag("lesson", null);
const outFile = flag("out", null);

const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
const openai = new OpenAI({
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_BASE_URL || "https://api.deepseek.com",
});

const legacyFile = path.join(
  __dirname,
  "..",
  "prompt_and_instruction_for_responses_api_2.txt",
);
const instructionFor = createInstructionBuilder({
  coreFile: path.join(
    __dirname,
    "..",
    "prompts",
    "system_instruction_core.txt",
  ),
  lessonsDir: path.join(__dirname, "..", "prompts", "lessons"),
});

/** Gói một group thành user message — sao y `gradeGroupWithOpenAI` của server. */
function buildInput(group) {
  const body = group
    .map((item, i) => {
      const seq = i + 1;
      const hasLeadingNumber = /^\s*\d+\s*\./.test(item.question || "");
      const question = hasLeadingNumber
        ? String(item.question).replace(/^\s*\d+\s*\./, `${seq}.`)
        : `${seq}. ${item.question}`;
      if (item.taskType === TASK_ACTIVE_PASSIVE) {
        return `\n[TASK]: ACTIVE_TO_PASSIVE\n[ACTIVE_SENTENCE]: ${question}\n[STUDENT_ANSWER]: ${item.answer}`;
      }
      return `\n[VIETNAMESE]: ${question}\n[STUDENT_ANSWER]: ${item.answer}`;
    })
    .join("\n");
  return `DATASET TO EVALUATE:\`\`\`\n${body}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;
}

/** Một lần chấm: trả về feedback theo vị trí trong group + số token đã dùng. */
async function grade(instruction, group) {
  const response = await openai.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: buildInput(group) },
    ],
    temperature: 0.5,
    top_p: 0.14,
  });
  const text = (response.choices?.[0]?.message?.content || "")
    .replace(/【.*?】|<br>|/g, "")
    .trim();
  const byStt = parseGradedTable(text, group.length);
  const usage = response.usage || {};
  return {
    feedbacks: group.map((_, i) => byStt[String(i + 1)] ?? null),
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    cacheHit: usage.prompt_cache_hit_tokens ?? 0,
  };
}

/** "✅ Đúng" hay không — thứ duy nhất học viên nhìn vào để biết mình sai. */
const isCorrect = (fb) => /✅/.test(String(fb ?? ""));

/** Lời giải thích trong ngoặc đơn cuối ô, dùng để đếm độ dài. */
function explanations(fb) {
  return String(fb ?? "").match(/\(([^()]*)\)/g) || [];
}

function formatIssues(fb) {
  const text = String(fb ?? "");
  const issues = [];
  if (text.includes("\n")) issues.push("xuống dòng giữa ô");
  if (/<br\s*\/?>/i.test(text)) issues.push("có thẻ html");
  if (isCorrect(text)) return issues;

  const bold = (text.match(/\*\*/g) || []).length / 2;
  if (bold === 0) issues.push("câu sai nhưng không bôi đậm");
  const limit = bold >= 2 ? 15 : 10;
  for (const paren of explanations(text)) {
    const words = paren.slice(1, -1).trim().split(/\s+/).filter(Boolean).length;
    if (words > limit) issues.push(`giải thích ${words} từ (trần ${limit})`);
  }
  return issues;
}

(async () => {
  const db = getDb(process.env.FIRESTORE_DATABASE_ID || "(default)");
  const snap = await db
    .collection("gradingCache")
    .limit(limit * 4)
    .get();
  const items = snap.docs
    .map((doc) => doc.data())
    .filter((d) => d && d.question && d.answer && d.feedback)
    .slice(0, limit);

  if (items.length === 0) {
    console.error("gradingCache không có bản ghi nào dùng được");
    process.exit(1);
  }

  // Tài liệu buổi được chọn theo lessonId; gradingCache không lưu trường này,
  // nên phải truyền vào bằng --lesson. Thiếu nó thì prompt mới rơi vào nhánh
  // fallback và phép so sánh mất ý nghĩa.
  if (!onlyLesson) {
    console.error(
      "Thiếu --lesson=lessonNN: gradingCache không lưu buổi, mà prompt mới chọn tài liệu theo buổi.",
    );
    process.exit(1);
  }

  const legacy = fs.readFileSync(legacyFile, "utf8").trim();
  const fresh = instructionFor(onlyLesson);
  console.log(
    `mẫu ${items.length} câu | buổi ${onlyLesson} | model ${AI_MODEL}\n` +
      `prompt cũ ${legacy.length} ký tự, prompt mới ${fresh.length} ký tự ` +
      `(${Math.round((1 - fresh.length / legacy.length) * 100)}% nhỏ hơn)\n`,
  );
  if (dryRun) {
    console.log("DRY RUN — không gọi AI");
    process.exit(0);
  }

  const groups = [];
  for (let i = 0; i < items.length; i += GROUP_SIZE) {
    groups.push(items.slice(i, i + GROUP_SIZE));
  }

  const totals = {
    legacy: { prompt: 0, completion: 0, cacheHit: 0 },
    fresh: { prompt: 0, completion: 0, cacheHit: 0 },
  };
  const rows = [];
  let flipped = 0;
  let issuesLegacy = 0;
  let issuesFresh = 0;

  for (const [index, group] of groups.entries()) {
    // Tuần tự, không song song: prefix cache cần lần gọi đầu hoàn tất mới có
    // gì để dùng lại, và chạy song song sẽ làm số đo cache vô nghĩa.
    const before = await grade(legacy, group);
    const after = await grade(fresh, group);
    for (const key of ["prompt", "completion", "cacheHit"]) {
      totals.legacy[key] += before[key];
      totals.fresh[key] += after[key];
    }
    group.forEach((item, i) => {
      const a = before.feedbacks[i];
      const b = after.feedbacks[i];
      const flip = isCorrect(a) !== isCorrect(b);
      if (flip) flipped += 1;
      issuesLegacy += formatIssues(a).length ? 1 : 0;
      issuesFresh += formatIssues(b).length ? 1 : 0;
      rows.push({
        question: item.question,
        answer: item.answer,
        legacy: a,
        fresh: b,
        flipped: flip,
        freshIssues: formatIssues(b),
      });
    });
    console.log(`group ${index + 1}/${groups.length} xong`);
  }

  const pct = (n) => `${Math.round((n / rows.length) * 100)}%`;
  console.log(`\n=== TOKEN (tổng ${groups.length} group) ===`);
  for (const [name, t] of Object.entries(totals)) {
    console.log(
      `${name.padEnd(7)} prompt=${t.prompt} (cache_hit=${t.cacheHit}) completion=${t.completion}`,
    );
  }
  console.log(
    `giảm input: ${Math.round((1 - totals.fresh.prompt / totals.legacy.prompt) * 100)}%`,
  );

  console.log(`\n=== CHẤM ===`);
  console.log(`đảo Đúng/Sai : ${flipped}/${rows.length} (${pct(flipped)})`);
  console.log(`lỗi format cũ : ${issuesLegacy}/${rows.length}`);
  console.log(`lỗi format mới: ${issuesFresh}/${rows.length}`);

  const changed = rows.filter((r) => r.flipped);
  if (changed.length) {
    console.log(`\n=== CÂU ĐẢO CHIỀU (tối đa 10) ===`);
    changed.slice(0, 10).forEach((r) => {
      console.log(`\nQ: ${r.question}\nA: ${r.answer}`);
      console.log(`  cũ : ${r.legacy}`);
      console.log(`  mới: ${r.fresh}`);
    });
  }

  if (outFile) {
    fs.writeFileSync(
      outFile,
      JSON.stringify({ totals, rows }, null, 2),
      "utf8",
    );
    console.log(`\nchi tiết đã ghi vào ${outFile}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error("so sánh thất bại:", err);
  process.exit(1);
});
