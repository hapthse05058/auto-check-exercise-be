// Runs the IELTS Writing prompt (prompt_ielts_writing.txt) against the REAL
// models configured by IELTS_AI_* / IELTS_CHART_AI_* on sample essays from the
// ChatGPT "chấm chữa viết" thread, and prints the feedback exactly as it would
// be written into the doc / shown on the website.
//
// Two uses:
//   1. Picking the provider/model: it proves the endpoint accepts `image_url`
//      content, returns JSON our parser accepts, and reads the chart numbers.
//   2. Eyeballing a prompt change before it ships.
// NOT part of `npm test`; it costs real AI calls. Nothing is cached or written.
//
//   node scripts/tryIeltsPrompt.js --fruit-chart <png|jpg>   (Task 1 needs it)
//   node scripts/tryIeltsPrompt.js --only task2 --raw
//   IELTS_AI_MODEL=... IELTS_AI_BASE_URL=... node scripts/tryIeltsPrompt.js
//   --no-chart-reader   send Task 1 images to IELTS_AI_MODEL even when
//                       IELTS_CHART_AI_* is set (the server's fallback path)
//
// With IELTS_CHART_AI_* set (as in the server), each chart is first read into
// text by that model — printed once — and the grader works from the text; the
// two Task 1 samples share the chart, so the second one reuses the read.
//
// What to check in the output:
//   - only the wrong word is bold, then "→ fix (reason)"; repeats not re-explained;
//   - the student's layout is kept (no added Intro/Body labels);
//   - Task 1: numbers match the chart, 2 body paragraphs, balanced grouping;
//   - whole-number bands; a gentle "em … nha" tone.
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const OpenAI = require("openai");

const ieltsChartData = require("../lib/ieltsChartData.js");
const ieltsWriting = require("../lib/ieltsWriting.js");

const args = process.argv.slice(2);
const argValue = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
};
const SHOW_RAW = args.includes("--raw");
const ONLY = argValue("--only");
const FRUIT_CHART = argValue("--fruit-chart");

const BASE_URL = process.env.IELTS_AI_BASE_URL || undefined;
const API_KEY = process.env.IELTS_AI_API_KEY;
const MODEL = process.env.IELTS_AI_MODEL;
const JSON_MODE = ["true", "1", "on"].includes(
  String(process.env.IELTS_AI_JSON_MODE || "").toLowerCase(),
);
const THINKING = String(process.env.IELTS_AI_THINKING || "")
  .trim()
  .toLowerCase();
if (!API_KEY || !MODEL) {
  console.error(
    "Set IELTS_AI_API_KEY and IELTS_AI_MODEL (and IELTS_AI_BASE_URL).",
  );
  process.exit(2);
}
const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });

const CHART_MODEL = args.includes("--no-chart-reader")
  ? null
  : process.env.IELTS_CHART_AI_API_KEY && process.env.IELTS_CHART_AI_MODEL;
const chartClient = CHART_MODEL
  ? new OpenAI({
      apiKey: process.env.IELTS_CHART_AI_API_KEY,
      baseURL: process.env.IELTS_CHART_AI_BASE_URL || undefined,
    })
  : null;

// Same request as callIeltsChartModel in server.js.
async function callChartModel(instruction, content, model) {
  const started = Date.now();
  const response = await chartClient.chat.completions.create({
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content },
    ],
    temperature: 0,
    max_tokens: 8000,
  });
  const text = response.choices?.[0]?.message?.content || "";
  console.log(
    `  (chart read by ${model}: ${Date.now() - started}ms, usage ${JSON.stringify(response.usage || {})})\n--- chart data ---\n${text.trim()}\n------------------`,
  );
  return text;
}

// Same request as callIeltsModel in server.js (which cannot be required: it
// starts the HTTP server on load).
async function callModel(instruction, content, model) {
  const params = {
    model,
    messages: [
      { role: "system", content: instruction },
      { role: "user", content },
    ],
    temperature: 0.3,
    max_tokens: 24000,
  };
  if (JSON_MODE) params.response_format = { type: "json_object" };
  if (THINKING) params.thinking = { type: THINKING };
  const started = Date.now();
  const response = await client.chat.completions.create(params);
  const text = response.choices?.[0]?.message?.content || "";
  console.log(
    `  (${Date.now() - started}ms, usage ${JSON.stringify(response.usage || {})})`,
  );
  if (SHOW_RAW) console.log(`--- raw AI response ---\n${text}\n`);
  return text;
}

function chartImage(file) {
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  return { mime: `image/${ext === "jpg" ? "jpeg" : ext}`, buffer };
}

const SAMPLES = [
  {
    name: "Task 2 – homework (agree/disagree)",
    task: "task2",
    prompt:
      "Some people think that children should not be given homework by their teachers at school. To what extent do you agree or disagree?",
    essay:
      "Some people think that children should not be given homework by their teachers at school.  But I disagree this view, although I don't like homework.  Firstly, homework can help children practice and remember the lessons better. Homework is really good for helping children practice themselves. It can help children remember the lessons and practice  them. It can also help them know how much knowledge they still remember about the lesson, and if they don't understand a part of the lessons, they can ask their teachers for help in time. Secondly, homework can help children remember the lessons at school. Children often forget the lessons after school, and homework can help with this. Homework can help them recall what they learned. It can help a lot because children are going to need this knowledge for the future lessons. But homework is not always good. Sometimes, children are really tired after school. Their brains need to rest, sleep and relax too. Homework is good for them, but not all the time. Children are human beings, and humans need to rest. Homework should only be given for sometimes, especially when the lessons are hard and need more practice. In conclusion, personally, I think homework is good for children, but just  only when necessary.",
  },
  {
    // Not the prompt's own worked example — so the model cannot copy it.
    name: "Task 2 – computer games vs sports (positive/negative)",
    task: "task2",
    prompt:
      "Nowadays, many children spend a lot of time playing computer games and little time doing sports. Is this a positive or negative development?",
    essay:
      "Nowadays, many children like playing computer games very much. They do not want to play sports outside because they like screens. I think this is a bad trend for children today.\n\nFirst, computer games are good sometimes. Children can play with friends. They can connect with somebody and help somebody entertain. They can develop quick thinking because games are fast. Some games have teams so they learn problem-solving/teamwork skills. But they play too much.\n\nSecond, the big problem is health. Children just sit all day and spend time on screens. This is very bad for eyes. They do not do exercise so they get fat. Playing sports is better because you can run and jump. If you only play games, you become lazy and weak. My brother plays games all day and he is very tired and fat.\n\nIn conclusion, computer games have some good things but it is a very harmful trend. Children need to play less games and do more sports to be healthy.",
  },
  {
    name: "Task 1 – fruit production 1970–2010 (line graph)",
    task: "task1",
    prompt:
      "The graph below shows the amount of fruit produced in four countries (Spain, Turkey, France, Germany) between 1970 and 2010. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.",
    essay:
      "The graph shows how much fruit was produced in spain, Turkey, France, and Germany from 1970 to 2010.\nOverall, Spain and Germany produced less fruit over the period, but Spain remained the top producer. In contrast, Turkey and France produced more fruit.\nIn 1970, Spain produced the most fruit with 5.6 million tonnes. This number grew slightly to 6.2 million tonnes in 1980, but then decreased slowly to 5.1 million tonnes in 2010. For Germany, fruit production declined steadily from 2.5 million tonnes in 1970 to around 1.1 million tonnes in 2010.\nLooking at the other countries, fruit production in Turkey increased slowly to 3.5 million tonnes in 2010. For France, the amount of fruit rose quickly to 2.1 million tonnes in 1990. After a small drop in 2000, French fruit production went up sharply to nearly 3.0 million tonnes in 2010.",
    images: FRUIT_CHART ? [chartImage(FRUIT_CHART)] : null,
  },
  {
    // Same chart, with 3 planted data errors the model MUST catch (Spain 2010
    // is 5.1 not 3.1; Germany fell, not rose; Spain, not Turkey, stayed top)
    // while leaving the near-miss estimates (Turkey 1.5, France 2.1) alone.
    name: "Task 1 – fruit, planted data errors",
    task: "task1",
    prompt:
      "The graph below shows the amount of fruit produced in four countries (Spain, Turkey, France, Germany) between 1970 and 2010. Summarise the information by selecting and reporting the main features, and make comparisons where relevant. Write at least 150 words.",
    essay:
      "The graph shows how much fruit was produced in Spain, Turkey, France and Germany from 1970 to 2010.\nOverall, Turkey, France and Germany produced more fruit over the period, and Turkey became the biggest producer by 2010.\nIn 1970, Spain produced 5.6 million tonnes of fruit. This number grew to 6.2 million tonnes in 1980, but then it dropped to 3.1 million tonnes in 2010. Germany's production increased from 2.5 million tonnes in 1970 to 3.0 million tonnes in 2010.\nTurkey produced 1.5 million tonnes in 1970 and this rose steadily to 3.5 million tonnes in 2010. For France, the amount of fruit rose to 2.1 million tonnes in 1990. After a small drop in 2000, it went up sharply to nearly 3.0 million tonnes in 2010.",
    images: FRUIT_CHART ? [chartImage(FRUIT_CHART)] : null,
  },
  {
    name: "Paragraph – Task 1 overview (crime line graph)",
    task: "paragraph",
    prompt:
      "Viết Introduction và Overview cho đề: The line graph shows the proportion of three types of crime (car theft, house burglary, street robbery) in England and Wales between 1970 and 2000.",
    essay:
      "The line graph illustrates the proportion of 3 sorts of crimes: car theft, house burglary, and street robbery in England and Wales between 1970 and 2000.Overall, it can be seen from the graph that the percentage of car theft and house burglary showed an upward trend, while the proportion of street robbery experienced slight fluctuations.",
  },
];

async function main() {
  const readPrompt = () =>
    fs.readFileSync(
      path.join(__dirname, "..", "prompt_ielts_writing.txt"),
      "utf8",
    );
  // A cache that stores nothing: every run asks the model.
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false }),
        set: async () => {},
      }),
    }),
  };
  // Charts, though, are kept in memory for the run, as the server keeps them in
  // Firestore: both Task 1 samples are about the same chart.
  const charts = new Map();
  const chartDb = {
    collection: () => ({
      doc: (id) => ({
        get: async () => ({
          exists: charts.has(id),
          data: () => charts.get(id),
        }),
        set: async (data) => void charts.set(id, data),
        update: async () => {},
      }),
    }),
  };
  const chartReader = CHART_MODEL
    ? ieltsChartData.createChartReader({
        db: chartDb,
        callModel: callChartModel,
        readPrompt: () =>
          fs.readFileSync(
            path.join(__dirname, "..", "prompt_ielts_chart.txt"),
            "utf8",
          ),
        model: process.env.IELTS_CHART_AI_MODEL,
        version: "try",
      })
    : null;
  const grader = ieltsWriting.createIeltsGrader({
    db,
    callModel,
    readPrompt,
    model: MODEL,
    promptVersion: "try",
    readChart: chartReader
      ? (images, options) =>
          chartReader.read(images, { ...options, useCache: true })
      : null,
  });
  console.log(
    `Grader: ${MODEL}` +
      (chartReader
        ? ` · charts read by ${process.env.IELTS_CHART_AI_MODEL}`
        : " · charts sent as images"),
  );

  let failures = 0;
  for (const sample of SAMPLES) {
    if (ONLY && sample.task !== ONLY) continue;
    if (sample.task === "task1" && !sample.images) {
      console.log(`\n=== ${sample.name}: SKIPPED (pass --fruit-chart <image>)`);
      continue;
    }
    console.log(`\n=== ${sample.name}`);
    try {
      const input = ieltsWriting.validateRequest(sample);
      const { result, feedback } = await grader.grade(input, {
        useCache: false,
      });
      console.log(feedback);
      console.log(
        `\n  → bands ${result.criteria.map((c) => `${c.key}=${c.band}`).join(" ")}` +
          `, overall ${result.overall}, ${result.wordCount} words`,
      );
    } catch (err) {
      failures++;
      console.error(`  FAILED: ${err.code || err.message}`);
    }
  }
  process.exit(failures ? 1 : 0);
}

main();
