// Runs the paragraph-grading prompt (prompt_paragraph.txt) against the real AI
// model on the five sample paragraphs from the "5 mẫu chấm đoạn văn" doc, and
// prints the feedback exactly as it would be written into the "GV sửa" cell.
//
// For eyeballing a prompt change before it ships — NOT part of `npm test`, and
// it costs a real AI call. Nothing is cached or written anywhere.
//
//   node scripts/tryParagraphPrompt.js
//   node scripts/tryParagraphPrompt.js --raw     (also print the AI's JSON)
//
// What to check in the output:
//   - a sentence with several mistakes is ONE block, not several;
//   - only the changed words are wrapped in **…**;
//   - each reason sits on its own line, a blank line between sentences;
//   - nothing is marked wrong for content, capitalisation or punctuation.
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");

const { gradeParagraphGroup } = require("../lib/paragraphFeedback.js");

// Same settings as callGrader in server.js (which cannot be required: it
// starts the HTTP server on load).
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.deepseek.com";
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
const AI_THINKING_ENABLED = ["enabled", "true", "1", "on"].includes(
  (process.env.AI_THINKING || "disabled").toLowerCase(),
);
const AI_REASONING_EFFORT = process.env.AI_REASONING_EFFORT || "high";
const openai = new OpenAI({ apiKey: AI_API_KEY, baseURL: AI_BASE_URL });

const SHOW_RAW = process.argv.includes("--raw");

async function callGrader(instruction, inputText, model) {
  const params = {
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content: inputText },
    ],
  };
  if (AI_THINKING_ENABLED) {
    params.reasoning_effort = AI_REASONING_EFFORT;
    params.thinking = { type: "enabled" };
  } else {
    params.temperature = 0.5;
    params.top_p = 0.14;
  }
  const response = await openai.chat.completions.create(params);
  const text = response.choices?.[0]?.message?.content || "";
  if (SHOW_RAW) console.log(`--- raw AI response ---\n${text}\n`);
  return text;
}

const SAMPLES = [
  {
    name: "Buổi 02 – Introducing yourself",
    question:
      "Chủ đề: Introducing yourself\nĐoạn văn mẫu:\nHello! My name is Teo. I am 18 years old.\nMy family has 4 people: my father, my mother, my sister, and me.",
    answer:
      "Hello! My name are Tom. I am have 18 years old.\nMy family have 4 people: my father, my mother, my brother, and me. My mother is a very kind. My father very funny. I love very much my family.\nMy best friend are Nam. We often talks and studying together. I am feel happy to meet everyone.\nThanks! Goodbye, everybody!",
  },
  {
    name: "Buổi 03 – Introducing yourself",
    question:
      "Chủ đề: Introducing yourself\nĐoạn văn mẫu:\nHey! Let me introduce myself to you today. I was born in Quang Nam province, Vietnam. I am sixteen years old this year.",
    answer:
      "Hey! Let me introducing myself to you today. I born in Da Nang, Vietnam. I have sixteen years old this year.\nI can speaks 2 languages: Vietnamese and English.\nMy classmates says I am a friendly and polite. I like talk and goes out with new friends. My dream are become a teacher.\nHow about you? Let’s sharing!",
  },
  {
    name: "Buổi 04 – Hobbies",
    question:
      "Chủ đề: Hobbies\nĐoạn văn mẫu:\nMy favourite hobby is playing the guitar, but I do not play it very well. I play it every weekend.",
    answer:
      "My favourite hobby are play the guitar, but I does not plays it very well. I play usually it every weekend.\nMy sister do not like playing the guitar, but she like play the piano. She think that it is very interesting.\nWhat are your favourite activity? Does you like playing sports, or watch TV? And where does you usually plays sports?",
  },
  {
    name: "Buổi 05 – Hobbies",
    question:
      "Chủ đề: Hobbies\nĐoạn văn mẫu:\nMy favourite hobby is listening to music, so I listen to music every day.",
    answer:
      "My favourite hobby are listening to music, so I listens to music every day. I am also interesting in draw, but I does not have time to do it every day.\nOn the weekend, my family and I often rides bicycles or walking in the park together. We has a lot of fun. During the holiday, we usually goes camping and takes a lot of photos. It are very relaxing.\nI always enjoy to spend time with my family and friends.",
  },
  {
    name: "Buổi 15 – Housing & Accommodation",
    question:
      "Chủ đề: Housing & Accommodation\nĐoạn văn mẫu:\nMy family lives in the countryside. Our house is next to the station.",
    answer:
      "My family live in the countryside. Our house are next to the station, and I can walking there in five minutes.\nI sleeps upstairs, and my parents sleeps downstairs. The toilet are under the stairs, and it is small but cleanly.\nThe man which live at the corner often give us fresh vegetables. I am feel comfortable here, and I does not want to live anywhere else.",
  },
];

async function main() {
  if (!AI_API_KEY) throw new Error("AI_API_KEY is not set (see .env)");
  const instruction = fs
    .readFileSync(path.join(__dirname, "..", "prompt_paragraph.txt"), "utf8")
    .trim();

  console.log(
    `Model: ${AI_MODEL} (thinking ${AI_THINKING_ENABLED ? "on" : "off"})\n`,
  );
  const started = Date.now();
  // One group of five: the same batching gradeItemsCached uses in production.
  const feedback = await gradeParagraphGroup(SAMPLES, {
    instruction,
    model: AI_MODEL,
    callGrader,
  });
  SAMPLES.forEach((sample, i) => {
    console.log(`===== ${sample.name} =====`);
    console.log(
      feedback[i] === null
        ? "(null — would be retried on the next run)"
        : feedback[i],
    );
    console.log();
  });
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
