// Chấm một bộ đề CÓ SẴN ĐÁP ÁN KỲ VỌNG bằng cả prompt cũ lẫn prompt mới.
//
// Khác `compareGradingPrompts.js` (lấy mẫu từ gradingCache, chỉ so hai bản AI
// với nhau): ở đây đề và lỗi gài đều do người viết, nên trả lời được câu hỏi
// mà phép so AI-với-AI không trả lời được — bản nào chấm ĐÚNG, chứ không phải
// bản nào chấm KHÁC.
//
// Hai chỉ số quan trọng, theo đúng thứ tự:
//   1. Bắt lỗi oan: câu vốn đúng mà bị báo sai. Tệ nhất, vì học viên mất lòng
//      tin vào toàn bộ phần chữa.
//   2. Bỏ sót: câu sai mà được cho qua.
//
//   node scripts/gradeSample.js --lesson=lesson02
//   node scripts/gradeSample.js --lesson=lesson02 --only=new
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");

const {
  createInstructionBuilder,
} = require("../lib/buildGradingInstruction.js");
const { parseGradedTable } = require("../lib/parseGradedTable.js");
const { SAMPLES } = require("./gradeSamples.data.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const lesson = flag("lesson", "lesson02");
const SAMPLE = SAMPLES[lesson];
if (!SAMPLE) {
  console.error(
    `Chưa có bộ đề cho ${lesson}. Có: ${Object.keys(SAMPLES).join(", ")}`,
  );
  process.exit(1);
}
const only = flag("only", "both"); // both | new | old

const openai = new OpenAI({
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_BASE_URL || "https://api.deepseek.com",
});
const instructionFor = createInstructionBuilder({
  coreFile: path.join(
    __dirname,
    "..",
    "prompts",
    "system_instruction_core.txt",
  ),
  lessonsDir: path.join(__dirname, "..", "prompts", "lessons"),
});

const userMessage = () => {
  const body = SAMPLE.map(
    (it) => `\n[VIETNAMESE]: ${it.question}\n[STUDENT_ANSWER]: ${it.answer}`,
  ).join("\n");
  return `DATASET TO EVALUATE:\`\`\`\n${body}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;
};

async function grade(instruction) {
  const response = await openai.chat.completions.create({
    model: process.env.AI_MODEL || "deepseek-chat",
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: userMessage() },
    ],
    temperature: 0.5,
    top_p: 0.14,
  });
  const text = (response.choices?.[0]?.message?.content || "")
    .replace(/【.*?】|<br>|/g, "")
    .trim();
  const byStt = parseGradedTable(text, SAMPLE.length);
  const u = response.usage || {};
  return {
    feedbacks: SAMPLE.map((it) => byStt[String(it.stt)] ?? null),
    usage: `prompt=${u.prompt_tokens} (cache_hit=${u.prompt_cache_hit_tokens ?? 0}) completion=${u.completion_tokens}`,
  };
}

const isCorrect = (fb) => /✅/.test(String(fb ?? ""));

/** Lỗi định dạng của một ô, theo quy tắc trong core. */
function formatIssues(fb) {
  const text = String(fb ?? "");
  const out = [];
  if (!text) return ["không có dòng"];
  if (text.includes("\n")) out.push("xuống dòng giữa ô");
  if (isCorrect(text)) {
    if (text.trim() !== "✅ Đúng") out.push("câu đúng nhưng viết thêm chữ");
    return out;
  }
  const bold = (text.match(/\*\*/g) || []).length / 2;
  if (bold === 0) out.push("không bôi đậm");
  const limit = bold >= 2 ? 15 : 10;
  for (const paren of text.match(/\(([^()]*)\)/g) || []) {
    const n = paren.slice(1, -1).trim().split(/\s+/).filter(Boolean).length;
    if (n > limit) out.push(`giải thích ${n} từ (trần ${limit})`);
  }
  return out;
}

function report(name, result) {
  console.log(
    `\n${"=".repeat(70)}\n${name}  —  ${result.usage}\n${"=".repeat(70)}`,
  );
  let wrongfulFlag = 0;
  let missed = 0;
  let formatBad = 0;

  SAMPLE.forEach((it, i) => {
    const fb = result.feedbacks[i];
    const shouldBeCorrect = it.expect === null;
    const gotCorrect = isCorrect(fb);
    const issues = formatIssues(fb);
    if (issues.length) formatBad += 1;

    let verdict = "ok";
    if (shouldBeCorrect && !gotCorrect) {
      verdict = "BẮT LỖI OAN";
      wrongfulFlag += 1;
    } else if (!shouldBeCorrect && gotCorrect) {
      verdict = "BỎ SÓT";
      missed += 1;
    }

    console.log(
      `\n[${String(it.stt).padStart(2)}] ${verdict}${issues.length ? ` | format: ${issues.join(", ")}` : ""}`,
    );
    console.log(`     gài : ${it.expect ?? "(câu đúng, không có lỗi)"}`);
    console.log(`     chấm: ${fb}`);
  });

  const total = SAMPLE.length;
  const correctItems = SAMPLE.filter((it) => it.expect === null).length;
  console.log(
    `\n--- ${name}: bắt lỗi oan ${wrongfulFlag}/${correctItems} | bỏ sót ${missed}/${total - correctItems} | lỗi format ${formatBad}/${total}`,
  );
  return { wrongfulFlag, missed, formatBad };
}

(async () => {
  console.log(
    `bộ đề ${SAMPLE.length} câu | buổi ${lesson} | model ${process.env.AI_MODEL}`,
  );

  if (only !== "new") {
    const legacy = fs
      .readFileSync(
        path.join(
          __dirname,
          "..",
          "prompt_and_instruction_for_responses_api_2.txt",
        ),
        "utf8",
      )
      .trim();
    report("PROMPT CŨ (mọi buổi)", await grade(legacy));
  }
  if (only !== "old") {
    report(
      `PROMPT MỚI (core + ${lesson})`,
      await grade(instructionFor(lesson)),
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error("chấm thất bại:", err);
  process.exit(1);
});
