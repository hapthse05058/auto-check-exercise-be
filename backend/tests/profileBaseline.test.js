/**
 * Golden baseline for the Basic and IELTS grading paths.
 *
 * Captured BEFORE the HS profile was added. Adding a grading profile must not
 * change a single byte of what Basic and IELTS send out: the items handed to
 * their graders, the Docs batchUpdate requests, the cache keys, the model
 * payloads built by the pure graders, the prompt files — and the server.js
 * functions that build the Basic sentence payload (not reachable from a unit
 * test, so their source text is pinned instead).
 *
 * Regenerate only on purpose: UPDATE_BASELINE=1 node --test tests/profileBaseline.test.js
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const { gradingCacheKey } = require("../lib/gradingKey.js");
const { gradeParagraphGroup } = require("../lib/paragraphFeedback.js");
const { createIeltsGrader, ieltsCacheKey } = require("../lib/ieltsWriting.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");
const {
  createHarness,
  makeIeltsTab,
  makeTab,
} = require("./helpers/gradingHarness.js");

const SNAPSHOT = path.join(__dirname, "fixtures", "profileBaseline.json");
const ROOT = path.join(__dirname, "..");

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** Runs a job to the end, recording every batchUpdate the harness receives. */
async function recordJob(h) {
  const writes = [];
  const original = h.docsApi.batchUpdate.bind(h.docsApi);
  h.docsApi.batchUpdate = async (docId, requests, token, opts) => {
    writes.push({ docId, requests });
    return original(docId, requests, token, opts);
  };
  const { jobId } = await h.start();
  await h.drain();
  writes.sort((a, b) => a.docId.localeCompare(b.docId));
  return { job: h.job(jobId), writes };
}

async function basicCapture() {
  const h = createHarness({
    tabs: {
      docA: makeTab({ answers: ["ok one", "I goes home"] }),
      docB: makeTab({
        answers: ["ok two", "She do it"],
        paragraph: { student: "My name are Tom." },
      }),
    },
  });
  const { job, writes } = await recordJob(h);
  return {
    written: job.written,
    gradedItems: h.counters.gradedItems
      .map((i) => ({
        question: i.question,
        answer: i.answer,
        taskType: i.taskType,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    writes,
  };
}

async function ieltsCapture() {
  const h = createHarness({
    tabs: {
      docA: makeIeltsTab({
        tables: [{ essay: "Homework is useless. I disagree." }],
      }),
      docB: makeIeltsTab({
        tables: [
          {
            title: "IELTS WRITING – TASK 1",
            essay: "The chart shows.",
            images: ["img1"],
          },
        ],
        objects: { img1: "https://img/1" },
      }),
    },
    gradingProfile: "ielts",
  });
  const { job, writes } = await recordJob(h);
  return {
    written: job.written,
    inputs: h.counters.ieltsInputs
      .map((i) => ({
        task: i.task,
        prompt: i.prompt,
        essay: i.essay,
        images: (i.images || []).length,
      }))
      .sort((a, b) => a.essay.localeCompare(b.essay)),
    images: h.counters.images.map((i) => i.uri),
    writes,
  };
}

function cacheKeys() {
  return {
    basic: [
      gradingCacheKey(
        "v1",
        "deepseek-chat",
        "1. Tôi là học sinh.",
        "→ I am a student",
        "vi_en",
      ),
      gradingCacheKey(
        "v2",
        "m",
        "Câu bị động",
        "It was done",
        "active_passive",
      ),
      gradingCacheKey(
        "v1",
        "m",
        "Đoạn văn mẫu",
        "My name are Tom.",
        "paragraph",
      ),
    ],
    ielts: [
      ieltsCacheKey({
        promptVersion: "v3",
        model: "deepseek-flash",
        task: "task2",
        prompt: "Discuss.",
        essay: "An essay.",
        images: [],
      }),
      ieltsCacheKey({
        promptVersion: "v3",
        model: "m",
        task: "task1",
        prompt: "Chart.",
        essay: "It rose.",
        images: [],
        chartData: "A: 1, B: 2",
      }),
    ],
  };
}

async function modelPayloads() {
  const calls = [];
  const record =
    (reply) =>
    async (...args) => {
      calls.push(JSON.parse(JSON.stringify(args)));
      return reply;
    };
  await gradeParagraphGroup(
    [
      {
        question: "Bài tập viết đoạn văn: Hobbies\nĐoạn văn mẫu",
        answer: "My hobby are music.",
      },
      { question: "Q2", answer: "I likes it." },
    ],
    {
      instruction: "PARAGRAPH-PROMPT",
      model: "m",
      callGrader: record('{"items":[]}'),
    },
  );
  const grader = createIeltsGrader({
    db: new FakeFirestore(),
    callModel: record("not json"),
    readPrompt: () => "IELTS-PROMPT",
    model: "m",
    promptVersion: "v3",
    now: () => 1,
    log: () => {},
  });
  try {
    await grader.grade({
      task: "task2",
      prompt: "Discuss.",
      essay: "An essay here.",
    });
  } catch {
    // the recorded payloads are what matter, not the (invalid) answer
  }
  return calls;
}

/** Source text of a top-level `function name(` / `async function name(` in server.js. */
function functionSource(source, name) {
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `server.js: function ${name} not found`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end + 2);
}

function pinnedSources() {
  // A Windows checkout (core.autocrlf) has CRLF; the snapshot is of LF text.
  const server = fs
    .readFileSync(path.join(ROOT, "server.js"), "utf8")
    .replace(/\r\n/g, "\n");
  const files = [
    "prompt_and_instruction_for_responses_api_2.txt",
    "prompt_paragraph.txt",
    "prompt_ielts_writing.txt",
    "prompt_ielts_chart.txt",
    // Builds the Basic sentence payload and checks every returned row.
    "lib/basicRows.js",
  ];
  return {
    prompts: Object.fromEntries(
      files.map((f) => [
        f,
        sha(fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n")),
      ]),
    ),
    serverFunctions: Object.fromEntries(
      [
        "callGrader",
        "gradeGroupWithOpenAI",
        "gradeItemsCached",
        "callIeltsModel",
      ].map((name) => [name, sha(functionSource(server, name))]),
    ),
  };
}

describe("Basic/IELTS golden baseline", () => {
  it("is byte-identical to the snapshot taken before the HS profile", async () => {
    const actual = JSON.parse(
      JSON.stringify({
        basic: await basicCapture(),
        ielts: await ieltsCapture(),
        cacheKeys: cacheKeys(),
        modelPayloads: await modelPayloads(),
        pinned: pinnedSources(),
      }),
    );
    if (process.env.UPDATE_BASELINE === "1" || !fs.existsSync(SNAPSHOT)) {
      fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
      fs.writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    assert.deepEqual(actual, expected);
  });
});
