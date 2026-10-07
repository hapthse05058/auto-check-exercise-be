const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  CACHE_COLLECTION,
  IeltsError,
  MAX_IMAGE_BYTES,
  countWords,
  createIeltsGrader,
  formatIeltsFeedback,
  ieltsFeedbackParts,
  describeResult,
  ieltsCacheKey,
  overallBand,
  parseIeltsResponse,
  pasteReceiptDocId,
  restoreLines,
  silentEdits,
  validateRequest,
} = require("../lib/ieltsWriting.js");
const { gradingCacheKey } = require("../lib/gradingKey.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");

const png = (text) =>
  `data:image/png;base64,${Buffer.from(text).toString("base64")}`;

function task2Json(overrides = {}) {
  return {
    task: "task2",
    corrected: "I **disagree** → disagree with this view. (giới từ)",
    improved: "I disagree with this view.",
    criteria: [
      { key: "TR", band: 6, comment: "Quan điểm rõ nha." },
      { key: "CC", band: 6, comment: "Bố cục ổn." },
      { key: "LR", band: 7, comment: "Từ vựng tốt." },
      { key: "GRA", band: 7, comment: "Ngữ pháp chắc." },
    ],
    general: "Bài ổn.",
    advice: "Em nên phát triển ví dụ nha.",
    ...overrides,
  };
}

const withCriteria = (criteria) => JSON.stringify(task2Json({ criteria }));

describe("overallBand (IELTS rounding of the average)", () => {
  const cases = [
    [[6, 6, 6, 6], 6],
    [[6, 6, 6, 7], 6.5], // 6.25 → 6.5
    [[6, 6, 7, 7], 6.5], // 6.5 stays
    [[6, 7, 7, 7], 7], // 6.75 → 7
    [[7, 7, 7, 8], 7.5], // 7.25 → 7.5
    [[5, 5, 5, 6], 5.5], // 5.25 → 5.5
    [[8, 8, 9, 9], 8.5],
    [[9, 9, 9, 9], 9],
    [[1, 1, 1, 2], 1.5],
    [[4, 5, 5, 5], 5], // 4.75 → 5
  ];
  for (const [bands, expected] of cases) {
    it(`${bands.join(",")} → ${expected}`, () => {
      assert.equal(overallBand(bands.map((band) => ({ band }))), expected);
    });
  }
  it("is null for a paragraph (no criteria)", () => {
    assert.equal(overallBand([]), null);
  });
  it("agrees with the rule stated on the average for every whole-band set", () => {
    for (let a = 1; a <= 9; a++)
      for (let b = a; b <= 9; b++)
        for (let c = b; c <= 9; c++)
          for (let d = c; d <= 9; d++) {
            const avg = (a + b + c + d) / 4;
            const whole = Math.floor(avg);
            const frac = avg - whole;
            const byRule =
              frac === 0
                ? whole
                : frac === 0.25 || frac === 0.5
                  ? whole + 0.5
                  : whole + 1;
            const got = overallBand([a, b, c, d].map((band) => ({ band })));
            assert.equal(got, byRule, `${a},${b},${c},${d}`);
          }
  });
});

describe("parseIeltsResponse", () => {
  it("accepts a valid answer, in or out of a code fence", () => {
    const text = JSON.stringify(task2Json());
    assert.ok(parseIeltsResponse(text, "task2"));
    assert.ok(parseIeltsResponse("```json\n" + text + "\n```", "task2"));
  });

  it("puts the criteria in canonical order", () => {
    const shuffled = [...task2Json().criteria].reverse();
    const parsed = parseIeltsResponse(withCriteria(shuffled), "task2");
    assert.deepEqual(
      parsed.criteria.map((c) => c.key),
      ["TR", "CC", "LR", "GRA"],
    );
  });

  it("drops fields the model adds, instead of refusing", () => {
    const text = JSON.stringify(task2Json({ overall: 9, extra: "x" }));
    const parsed = parseIeltsResponse(text, "task2");
    assert.ok(parsed);
    assert.equal("overall" in parsed, false);
    assert.equal("extra" in parsed, false);
  });

  const bad = {
    "not JSON": "hello",
    "an array": "[]",
    "missing corrected": JSON.stringify(task2Json({ corrected: undefined })),
    "empty advice": JSON.stringify(task2Json({ advice: "  " })),
    "unknown task": JSON.stringify(task2Json({ task: "task3" })),
    "3 criteria": withCriteria(task2Json().criteria.slice(0, 3)),
    "duplicate key": withCriteria([
      { key: "TR", band: 6, comment: "a" },
      { key: "TR", band: 6, comment: "b" },
      { key: "LR", band: 6, comment: "c" },
      { key: "GRA", band: 6, comment: "d" },
    ]),
    "TA on task 2": withCriteria([
      { key: "TA", band: 6, comment: "a" },
      { key: "CC", band: 6, comment: "b" },
      { key: "LR", band: 6, comment: "c" },
      { key: "GRA", band: 6, comment: "d" },
    ]),
    "band 0": withCriteria(
      task2Json().criteria.map((c, i) => (i ? c : { ...c, band: 0 })),
    ),
    "band 10": withCriteria(
      task2Json().criteria.map((c, i) => (i ? c : { ...c, band: 10 })),
    ),
    "half band": withCriteria(
      task2Json().criteria.map((c, i) => (i ? c : { ...c, band: 6.5 })),
    ),
    "band as string": withCriteria(
      task2Json().criteria.map((c, i) => (i ? c : { ...c, band: "6" })),
    ),
    "empty comment": withCriteria(
      task2Json().criteria.map((c, i) => (i ? c : { ...c, comment: "" })),
    ),
  };
  for (const [name, text] of Object.entries(bad)) {
    it(`rejects ${name}`, () => {
      assert.equal(parseIeltsResponse(text, "task2"), null);
    });
  }

  it("rejects a task other than the one asked for", () => {
    assert.equal(
      parseIeltsResponse(JSON.stringify(task2Json()), "task1"),
      null,
    );
  });

  it("task 1 needs exactly TA, CC, LR, GRA", () => {
    const task1 = (keys) =>
      JSON.stringify(
        task2Json({
          task: "task1",
          criteria: keys.map((key) => ({ key, band: 6, comment: "x" })),
        }),
      );
    assert.ok(parseIeltsResponse(task1(["TA", "CC", "LR", "GRA"]), "task1"));
    assert.equal(
      parseIeltsResponse(task1(["TR", "CC", "LR", "GRA"]), "task1"),
      null,
    );
    assert.equal(
      parseIeltsResponse(task1(["TA", "TA", "LR", "GRA"]), "task1"),
      null,
    );
    assert.equal(parseIeltsResponse(task1(["TA", "CC", "LR"]), "task1"), null);
  });

  it("a paragraph has no criteria, and no overall", () => {
    const text = JSON.stringify(task2Json({ task: "paragraph", criteria: [] }));
    const parsed = parseIeltsResponse(text, "paragraph");
    assert.ok(parsed);
    const described = describeResult(parsed, "One two three.");
    assert.deepEqual(described.criteria, []);
    assert.equal(described.overall, null);
    assert.equal(described.wordCount, 3);
    for (const field of ["corrected", "improved", "general", "advice"]) {
      assert.ok(described[field]);
    }
    const feedback = formatIeltsFeedback(described);
    assert.doesNotMatch(feedback, /Overall/);
    assert.doesNotMatch(feedback, /undefined|null/);

    const withCriteriaPara = JSON.stringify(task2Json({ task: "paragraph" }));
    assert.equal(parseIeltsResponse(withCriteriaPara, "paragraph"), null);
  });
});

describe("validateRequest", () => {
  const base = { task: "task2", prompt: "Đề", essay: "My essay." };

  it("Task 2 ignores images", () => {
    assert.deepEqual(
      validateRequest({ ...base, images: [png("x")] }).images,
      [],
    );
  });

  it("a paragraph keeps its chart images, which are optional", () => {
    const para = { ...base, task: "paragraph" };
    assert.deepEqual(validateRequest(para).images, []);
    const kept = validateRequest({ ...para, images: [png("a"), png("b")] });
    assert.deepEqual(
      kept.images.map((image) => image.buffer.toString()),
      ["a", "b"],
    );
    assert.throws(
      () =>
        validateRequest({
          ...para,
          images: [png("a"), png("b"), png("c"), png("d")],
        }),
      (err) => err.code === "too_many_images",
    );
  });

  it("Task 1 needs 1..3 valid charts of at most 2MB each", () => {
    const t1 = { ...base, task: "task1" };
    const code = (input) => {
      try {
        validateRequest(input);
        return "ok";
      } catch (err) {
        assert.ok(err instanceof IeltsError);
        assert.equal(err.status, 400);
        return err.code;
      }
    };
    assert.equal(code(t1), "chart_required");
    assert.equal(code({ ...t1, images: [] }), "chart_required");
    assert.equal(code({ ...t1, images: [png("a")] }), "ok");
    assert.equal(code({ ...t1, images: [png("a"), png("b"), png("c")] }), "ok");
    assert.equal(
      code({ ...t1, images: [png("a"), png("b"), png("c"), png("d")] }),
      "too_many_images",
    );
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString("base64");
    assert.equal(
      code({ ...t1, images: [`data:image/png;base64,${big}`] }),
      "image_too_large",
    );
    assert.equal(
      code({ ...t1, images: ["data:text/plain;base64,aGk="] }),
      "invalid_image",
    );
    assert.equal(code({ ...t1, images: ["not a data url"] }), "invalid_image");
  });

  it("refuses an unknown task and empty text", () => {
    assert.throws(
      () => validateRequest({ ...base, task: "x" }),
      /invalid_task/,
    );
    assert.throws(
      () => validateRequest({ ...base, essay: " " }),
      /essay_required/,
    );
    assert.throws(
      () => validateRequest({ ...base, prompt: "" }),
      /prompt_required/,
    );
  });
});

describe("cache key", () => {
  const input = (overrides = {}) =>
    validateRequest({
      task: "task1",
      prompt: "The chart shows fruit production.",
      essay: "The line graph illustrates fruit production.",
      images: [png("chart A")],
      ...overrides,
    });
  const key = (inp, promptVersion = "v1", model = "m1") =>
    ieltsCacheKey({ promptVersion, model, ...inp });

  it("same essay + same image → same key (HIT)", () => {
    assert.equal(key(input()), key(input()));
  });
  it("same essay + different image → different key", () => {
    assert.notEqual(key(input()), key(input({ images: [png("chart B")] })));
  });
  it("same image + different essay → different key", () => {
    assert.notEqual(key(input()), key(input({ essay: "Another essay." })));
  });
  it("different model or prompt version → different key", () => {
    assert.notEqual(key(input()), key(input(), "v1", "m2"));
    assert.notEqual(key(input()), key(input(), "v2", "m1"));
  });
  it("image order matters, whitespace noise does not", () => {
    const two = input({ images: [png("a"), png("b")] });
    const swapped = input({ images: [png("b"), png("a")] });
    assert.notEqual(key(two), key(swapped));
    const spaced = input({
      essay: "The line graph   illustrates fruit production.  \r\n",
    });
    assert.equal(key(input()), key(spaced));
  });
  it("never collides with a Basic key for the same text", () => {
    const i = input();
    const basic = gradingCacheKey("v1", "m1", i.prompt, i.essay, "paragraph");
    assert.notEqual(key(i), basic);
  });
  it("the paste receipt follows the same identity", () => {
    assert.equal(pasteReceiptDocId(input()), pasteReceiptDocId(input()));
    assert.notEqual(
      pasteReceiptDocId(input()),
      pasteReceiptDocId(input({ images: [png("chart B")] })),
    );
    assert.match(pasteReceiptDocId(input()), /^ielts-paste:[0-9a-f]{64}$/);
  });
});

describe("countWords", () => {
  it("counts words, not punctuation", () => {
    assert.equal(countWords("Hello , world - 2010 ! "), 3);
    assert.equal(countWords(""), 0);
  });
});

describe("restoreLines", () => {
  const essay =
    "Sales rose in 2010. They fell after that.\nPrices were stable overall.";

  it("joins a student paragraph the model split after an explanation", () => {
    const corrected =
      "Sales **rose** → increased (từ vựng) in 2010.\n\nThey fell after that.\nPrices were stable overall.";
    assert.equal(
      restoreLines(essay, corrected),
      "Sales **rose** → increased (từ vựng) in 2010. They fell after that.\nPrices were stable overall.",
    );
  });

  it("keeps the student's own line breaks, blank lines and the notes", () => {
    const corrected =
      "Sales rose in 2010. They fell after that.\n\n**[Overview thiếu ý]** → note\nPrices were stable overall.";
    assert.equal(restoreLines(essay, corrected), corrected);
  });

  it("never joins a note line, nor the line after a note, onto the paragraph", () => {
    const corrected =
      "Sales rose in 2010.\n**[Ý bị lặp]** → note\nThey fell after that.\nPrices were stable overall.";
    assert.equal(restoreLines(essay, corrected), corrected);
  });

  it("leaves a clean answer untouched", () => {
    assert.equal(restoreLines(essay, essay), essay);
  });
});

describe("silentEdits", () => {
  it("a marked fix keeps every word of the student", () => {
    assert.deepEqual(
      silentEdits(
        "It rose to 13 in 2010 and people reside to Australia.",
        "It rose to **13** → 13% in 2010 and people **reside** → moved (dùng từ) to Australia.",
      ),
      [],
    );
    assert.deepEqual(
      silentEdits("They like the music.", "They like **the** → (bỏ) music."),
      [],
    );
  });

  it("finds words changed or dropped without a mark", () => {
    const edits = silentEdits(
      "It rose to 13 in 2010, which helped to solve this problem quickly.",
      "It rose to 13% in 2010, which helped quickly.",
    );
    assert.deepEqual(
      edits.map((e) => e.words),
      ["13", "to solve this problem"],
    );
    assert.match(edits[0].context, /rose to 13 in 2010/);
  });

  it("ignores case, outer punctuation, curly quotes and the bold markers", () => {
    assert.deepEqual(
      silentEdits(
        "Children don’t read, sadly.",
        "**children** don't read sadly",
      ),
      [],
    );
  });

  it("an added '$' or '%' is not a match for the bare number", () => {
    assert.deepEqual(
      silentEdits("It cost 22 billion.", "It cost $22 billion.").map(
        (e) => e.words,
      ),
      ["22"],
    );
  });
});

describe("grader: retry and cache", () => {
  function setup(answers) {
    const db = new FakeFirestore();
    const calls = [];
    const grader = createIeltsGrader({
      db,
      readPrompt: () => "PROMPT",
      model: "m1",
      promptVersion: "v1",
      now: () => 1,
      log: () => {},
      callModel: async (instruction, content, model) => {
        calls.push({ instruction, content, model });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    return { db, grader, calls };
  }
  const input = () =>
    validateRequest({
      task: "task2",
      prompt: "Đề bài",
      essay: "I disagree this view.",
    });

  it("retries once after a malformed answer", async () => {
    const { grader, calls } = setup(["oops", JSON.stringify(task2Json())]);
    const { result, cached } = await grader.grade(input());
    assert.equal(calls.length, 2);
    assert.equal(cached, false);
    assert.equal(result.overall, 6.5);
    assert.equal(result.criteria[0].name, "Task Response");
  });

  it("retries once after a model error", async () => {
    const { grader, calls } = setup([
      new Error("boom"),
      JSON.stringify(task2Json()),
    ]);
    await grader.grade(input());
    assert.equal(calls.length, 2);
  });

  it("returns the corrected text with the student's line breaks put back", async () => {
    const split = JSON.stringify(
      task2Json({
        corrected: "I **disagree** → disagree with (giới từ)\nthis view.",
      }),
    );
    const { grader, calls } = setup([split]);
    const { result } = await grader.grade(input());
    assert.equal(calls.length, 1);
    assert.equal(
      result.corrected,
      "I **disagree** → disagree with (giới từ) this view.",
    );
  });

  it("retries once when the corrected text edits the student's words silently", async () => {
    const silent = JSON.stringify(
      task2Json({ corrected: "I disagree with the view." }),
    );
    const { grader, calls } = setup([silent, JSON.stringify(task2Json())]);
    const { result } = await grader.grade(input());
    assert.equal(calls.length, 2);
    assert.equal(calls[0].content.length, 1);
    const reminder = calls[1].content.at(-1).text;
    assert.match(reminder, /[KIỂM TRA LẠI]/);
    assert.match(reminder, /"this"/);
    assert.equal(result.corrected, task2Json().corrected);
  });

  it("keeps the attempt with fewer silent edits when both have some", async () => {
    const worse = JSON.stringify(task2Json({ corrected: "We agree." }));
    const better = JSON.stringify(
      task2Json({ corrected: "I disagree with the view." }),
    );
    const first = setup([worse, better]);
    assert.equal(
      (await first.grader.grade(input())).result.corrected,
      "I disagree with the view.",
    );
    const second = setup([better, worse, worse]);
    assert.equal(
      (await second.grader.grade(input())).result.corrected,
      "I disagree with the view.",
    );
    assert.equal(second.calls.length, 3, "still losing words: one more try");
  });

  it("asks a third time when the retry comes back broken, and uses it when clean", async () => {
    const silent = JSON.stringify(
      task2Json({ corrected: "I disagree with the view." }),
    );
    const { grader, calls } = setup([
      silent,
      "{broken",
      JSON.stringify(task2Json()),
      "never asked",
    ]);
    const { result } = await grader.grade(input());
    assert.equal(calls.length, 3);
    assert.equal(result.corrected, task2Json().corrected);
    // The third attempt still names the words to keep.
    assert.match(calls[2].content.at(-1).text, /"this"/);
  });

  it("keeps the silent-edit answer when the third try is unusable too", async () => {
    const silent = JSON.stringify(
      task2Json({ corrected: "I disagree with the view." }),
    );
    const { grader, calls } = setup([silent, "{broken", new Error("boom")]);
    const { result } = await grader.grade(input());
    assert.equal(calls.length, 3);
    assert.equal(result.corrected, "I disagree with the view.");
  });

  it("no third try after a clean answer or after two unusable ones", async () => {
    const clean = setup([
      "{broken",
      JSON.stringify(task2Json()),
      "never asked",
    ]);
    await clean.grader.grade(input());
    assert.equal(clean.calls.length, 2);
    const broken = setup(["{broken", "{broken", JSON.stringify(task2Json())]);
    await assert.rejects(broken.grader.grade(input()));
    assert.equal(broken.calls.length, 2);
  });

  it("a clean first answer is asked once", async () => {
    const { grader, calls } = setup([JSON.stringify(task2Json())]);
    await grader.grade(input());
    assert.equal(calls.length, 1);
  });

  it("fails after two bad answers and caches nothing", async () => {
    const { db, grader, calls } = setup(["oops", "still bad", "never asked"]);
    await assert.rejects(grader.grade(input()), (err) => {
      assert.ok(err instanceof IeltsError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "ielts_ai_invalid");
      return true;
    });
    assert.equal(calls.length, 2);
    assert.equal(Object.keys(db.dump(CACHE_COLLECTION)).length, 0);
  });

  it("serves the second identical request from the cache", async () => {
    const { grader, calls } = setup([JSON.stringify(task2Json())]);
    const first = await grader.grade(input());
    const second = await grader.grade(input());
    assert.equal(calls.length, 1);
    assert.equal(second.cached, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(second.feedback, first.feedback);
  });

  it("skips the cache when asked", async () => {
    const answer = JSON.stringify(task2Json());
    const { grader, calls } = setup([answer, answer]);
    await grader.grade(input());
    await grader.grade(input(), { useCache: false });
    assert.equal(calls.length, 2);
  });

  it("sends the system prompt, the text and the chart images", async () => {
    const { grader, calls } = setup([
      JSON.stringify(
        task2Json({
          task: "task1",
          criteria: ["TA", "CC", "LR", "GRA"].map((key) => ({
            key,
            band: 6,
            comment: "x",
          })),
        }),
      ),
    ]);
    await grader.grade(
      validateRequest({
        task: "task1",
        prompt: "Chart",
        essay: "Essay",
        images: [png("A"), png("B")],
      }),
    );
    const { instruction, content, model } = calls[0];
    assert.equal(instruction, "PROMPT");
    assert.equal(model, "m1");
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /\[TASK\]: task1/);
    assert.deepEqual(
      content.slice(1).map((part) => part.type),
      ["image_url", "image_url"],
    );
    assert.equal(content[1].image_url.url, png("A"));
  });
});

describe("formatIeltsFeedback", () => {
  it("writes the three parts without numbers, bands or overall", () => {
    const described = describeResult(
      parseIeltsResponse(JSON.stringify(task2Json()), "task2"),
      "essay words",
    );
    const text = formatIeltsFeedback(described);
    assert.match(text, /^\*\*BẢN CHỮA\*\*/);
    assert.match(text, /\n\*\*BẢN CẢI THIỆN\*\*\n/);
    assert.match(text, /\n\*\*NHẬN XÉT\*\*\n/);
    assert.match(text, /- \*\*Task Response:\*\* Quan điểm rõ nha\./);
    assert.match(text, /\*\*Lời khuyên cải thiện:\*\*/);
    assert.doesNotMatch(text, /Overall|\d\.\s*B|\(\d\)/);
  });

  it("splits into corrected / improved / review for the doc's table", () => {
    const described = describeResult(
      parseIeltsResponse(JSON.stringify(task2Json()), "task2"),
      "essay words",
    );
    const parts = ieltsFeedbackParts(described);
    assert.equal(parts.corrected, described.corrected);
    assert.equal(parts.improved, described.improved);
    assert.match(parts.review, /^- \*\*Task Response:\*\* /);
    assert.match(parts.review, /\n\*\*Nhận xét chung:\*\* /);
    assert.match(parts.review, /\n\*\*Lời khuyên cải thiện:\*\* [^\n]+$/);
    assert.doesNotMatch(parts.review, /NHẬN XÉT|Overall|\(\d\)/);
  });

  it("never leaves an unpaired ** or single-* italics on a line", () => {
    const described = describeResult(
      parseIeltsResponse(
        JSON.stringify(
          task2Json({ corrected: "a **b → c *(giới từ)*\nd **e** f" }),
        ),
        "task2",
      ),
      "x",
    );
    const text = formatIeltsFeedback(described);
    for (const line of text.split("\n")) {
      assert.equal((line.match(/\*\*/g) || []).length % 2, 0, line);
    }
    assert.match(text, /\(giới từ\)/);
    assert.doesNotMatch(text, /(?<!\*)\*\(/);
  });
});
