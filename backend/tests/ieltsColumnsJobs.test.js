/**
 * Grading jobs on the teachers' 2-column IELTS layout (buổi 4 of the IELTS
 * docs): "Bài viết của học viên" | "GV chữa/nhận xét", the prompt and chart
 * above the table. The job reads the writing, the prompt and the chart above
 * the table, and writes below the "GV chữa/nhận xét" heading in a named
 * range. Reading/writing details are tested in the website's
 * tests/ieltsColumns.test.js; this is the job around them.
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  IELTS_FEEDBACK,
  createHarness,
} = require("./helpers/gradingHarness.js");

const ESSAY = "The line graph illustrates the number of crimes in a city.";
const PROMPT = "The graph below shows the number of incidents of car theft.";

/** A paragraph whose one run carries its Docs indexes. */
const para = (text, at) => ({
  startIndex: at,
  endIndex: at + text.length,
  paragraph: {
    elements: [
      {
        startIndex: at,
        endIndex: at + text.length,
        textRun: { content: text },
      },
    ],
  },
});

/** "Writing buổi 10" laid out like buổi 4; `head` is the student's heading. */
function columnsDoc({ head = "Bài viết của học viên", essay = ESSAY } = {}) {
  const writes = [];
  const fbCell = { content: [para("GV chữa/nhận xét\n", 400)] };
  const tab = {
    tabProperties: { title: "Writing buổi 10", tabId: "t.w" },
    documentTab: {
      inlineObjects: {
        chart1: {
          inlineObjectProperties: {
            embeddedObject: {
              imageProperties: { contentUri: "https://img/1" },
            },
          },
        },
      },
      body: {
        content: [
          para(
            "Exercise 2: Dựa vào bài tập 1, hãy viết bài hoàn chỉnh miêu tả biểu đồ sau\n",
            1,
          ),
          para(`${PROMPT}\n`, 100),
          {
            startIndex: 200,
            endIndex: 202,
            paragraph: {
              elements: [
                {
                  startIndex: 200,
                  endIndex: 201,
                  inlineObjectElement: { inlineObjectId: "chart1" },
                },
                { startIndex: 201, endIndex: 202, textRun: { content: "\n" } },
              ],
            },
          },
          {
            table: {
              tableRows: [
                {
                  tableCells: [
                    {
                      content: [
                        para(`${head}\n`, 300),
                        para(`${essay}\n`, 330),
                      ],
                    },
                    fbCell,
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  };
  // Docs, for the requests the 2-column write sends: the inserted text
  // becomes the paragraphs below the heading.
  const apply = (_tab, requests) => {
    writes.push(requests);
    const insert = requests.find((r) => r.insertText).insertText;
    const lines = insert.text.split("\n").slice(1);
    let at = 400 + "GV chữa/nhận xét\n".length;
    fbCell.content = [
      fbCell.content[0],
      ...lines.map((line) => {
        const p = para(`${line}\n`, at);
        at += line.length + 1;
        return p;
      }),
    ];
  };
  return { value: { tab, apply }, writes, fbCell };
}

const cellText = (cell) =>
  cell.content
    .map((p) =>
      p.paragraph.elements.map((e) => e.textRun?.content ?? "").join(""),
    )
    .join("")
    .replace(/\n$/, "");

async function runJob(h) {
  const { jobId } = await h.start();
  await h.drain();
  return jobId;
}

describe("IELTS grading job, 2-column layout", () => {
  it("grades the writing with the prompt and chart above, writes below the heading", async () => {
    const doc = columnsDoc();
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    const jobId = await runJob(h);

    assert.equal(h.job(jobId).written, 1);
    assert.equal(h.points(), 9);
    const [input] = h.counters.ieltsInputs;
    assert.equal(input.task, "task1");
    assert.equal(input.essay, ESSAY);
    assert.match(input.prompt, /^Exercise 2: .*hoàn chỉnh/);
    assert.ok(input.prompt.includes(PROMPT));
    assert.equal(input.images.length, 1);
    assert.deepEqual(
      h.counters.images.map((i) => i.uri),
      ["https://img/1"],
    );

    // One write: below the heading (index 400 + heading - "\n"), named range.
    const [requests] = doc.writes;
    const insert = requests.find((r) => r.insertText).insertText;
    assert.equal(insert.location.index, 400 + "GV chữa/nhận xét".length);
    assert.equal(insert.text, `\n${IELTS_FEEDBACK.replaceAll("**", "")}`);
    const named = requests.find((r) => r.createNamedRange).createNamedRange;
    assert.match(named.name, /^aiFb:ielts:v1:/);
    assert.equal(
      cellText(doc.fbCell),
      `GV chữa/nhận xét\n${IELTS_FEEDBACK.replaceAll("**", "")}`,
    );
  });

  it("the heading's label decides the task", async () => {
    const doc = columnsDoc({ head: "Bài viết của học viên (Đoạn văn)" });
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    await runJob(h);
    assert.equal(h.counters.ieltsInputs[0].task, "paragraph");
  });

  it("a second run finds it graded: nothing written, nothing charged", async () => {
    const doc = columnsDoc();
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    await runJob(h);
    await runJob(h);
    assert.equal(doc.writes.length, 1);
    assert.equal(h.points(), 9);
    assert.equal(h.counters.ielts, 1);
  });

  it("an empty writing cell is not graded", async () => {
    const doc = columnsDoc({ essay: "" });
    const h = createHarness({
      tabs: { docA: doc.value },
      points: 10,
      gradingProfile: "ielts",
    });
    await runJob(h);
    assert.equal(h.counters.ielts, 0);
    assert.equal(doc.writes.length, 0);
    assert.equal(h.points(), 10);
  });
});
