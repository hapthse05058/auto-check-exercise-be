/**
 * Everything a grading-job test needs around lib/gradingJobs.js: an in-memory
 * Firestore, a fake Google Docs that really applies the inserts it receives
 * (so a re-read shows what was written), a hand-driven task queue, and fault
 * injection for each external call.
 */
const { FakeFirestore, createFakeAdmin } = require("./fakeFirestore.js");
const { DocsApiError } = require("../../lib/googleDocsApi.js");
const { createGradingJobs } = require("../../lib/gradingJobs.js");
const { scheduleAwareOnFinished } = require("../../lib/gradingSchedules.js");
const { consumePointsForDocs } = require("../../lib/teacherPoints.js");

const LESSON = "BUỔI 10 - Lesson";

/** Paragraph with one run, indexed like the Docs API indexes a cell. */
const P = (text, startIndex = 1) => ({
  startIndex,
  paragraph: { elements: [{ textRun: { content: text } }] },
});
const row = (...cells) => ({
  tableCells: cells.map((content) => ({ content })),
});

/** Where the paragraph table's "GV sửa" cell starts. */
const PARAGRAPH_FB_AT = 700;

/** A formatted paragraph correction: two sentences, blank line between. */
const PARAGRAPH_FEEDBACK =
  "My name **is** Tom.\n(S “My name” số ít → dùng “is” nhé.)\n\nI **usually play** it every weekend.\n(“Usually” đứng trước V thường nhé.)";

/**
 * "Bài tập viết đoạn văn", laid out like the real Docs API JSON: the title
 * spans two columns and leaves a placeholder cell holding "\n".
 */
function makeParagraphTable({ student = "", feedback = "" } = {}) {
  const lines = (text, start) =>
    text
      ? text.split("\n").map((line) => P(`${line}\n`, start))
      : [P("\n", start)];
  return [
    {
      tableCells: [
        {
          content: [P("Bài tập viết đoạn văn: Hobbies \n")],
          tableCellStyle: { columnSpan: 2 },
        },
        { content: [P("\n")] },
        { content: [P("GV sửa\n")] },
      ],
    },
    row(
      [P("Đoạn văn mẫu\n")],
      [P("My favourite hobby is playing the guitar.\n")],
      [P("\n", 650)],
    ),
    row(
      [P("Học viên viết\n")],
      lines(student, 660),
      lines(feedback, PARAGRAPH_FB_AT),
    ),
  ];
}

/**
 * One student's lesson tab: the legacy 3-column table with `answers.length`
 * questions (feedback cell i at 50 + 40*i) and the overall-comment row at 900.
 * `feedback[i]` pre-fills a feedback cell (an already graded doc).
 * `paragraph` ({student, feedback}) adds a paragraph table between the two.
 * `overall` pre-fills text after the overall label.
 */
function makeTab({
  answers,
  feedback = [],
  title = LESSON,
  paragraph = null,
  overall = "",
}) {
  const rows = [
    row([P("STT")], [P("Đề bài")], [P("Chữa bài")]),
    row([P("")], [P("")], [P("")]),
    ...answers.map((answer, i) =>
      row(
        [P(`${i + 1}. Câu hỏi số ${i + 1}\n`), P(`→ ${answer}\n`)],
        [P("")],
        [P(feedback[i] ? `${feedback[i]}\n` : "\n", 50 + 40 * i)],
      ),
    ),
  ];
  return {
    tabProperties: { title, tabId: "t.x" },
    documentTab: {
      body: {
        content: [
          { table: { tableRows: rows } },
          ...(paragraph
            ? [{ table: { tableRows: makeParagraphTable(paragraph) } }]
            : []),
          {
            table: {
              tableRows: [
                row([P(`Nhận xét chung của Giáo viên:${overall}\n`, 900)]),
              ],
            },
          },
        ],
      },
    },
  };
}

/** Default AI feedback for one IELTS submission (lib/ieltsWriting format). */
const IELTS_FEEDBACK =
  "**1. BẢN CHỮA**\nI **go** → went (thì)\n\n**3. NHẬN XÉT**\n**Overall: 6.5**";

/**
 * An IELTS lesson tab (lib/doc/ieltsDoc.js template): one table per entry of
 * `tables` — {title, prompt, images: [objectId], essay, feedback}. Table i's
 * "GV chữa" cell starts at 2000 + 1000*i. `objects` maps objectId → uri.
 */
function makeIeltsTab({ tables, objects = {}, title = LESSON }) {
  const P2 = (text, at) => P(`${text}\n`, at);
  const image = (id) => ({
    startIndex: 1,
    paragraph: { elements: [{ inlineObjectElement: { inlineObjectId: id } }] },
  });
  return {
    tabProperties: { title, tabId: "t.x" },
    documentTab: {
      inlineObjects: Object.fromEntries(
        Object.entries(objects).map(([id, uri]) => [
          id,
          {
            inlineObjectProperties: {
              embeddedObject: { imageProperties: { contentUri: uri } },
            },
          },
        ]),
      ),
      body: {
        content: tables.map((t, i) => {
          const at = 2000 + 1000 * i;
          return {
            table: {
              tableRows: [
                row(
                  [P2(t.title || "IELTS WRITING – TASK 2", at - 100)],
                  [P2("", at - 99)],
                ),
                row(
                  [P2("Đề bài", at - 98)],
                  [
                    P2(t.prompt || "Some people think … Discuss.", at - 97),
                    ...(t.images || []).map(image),
                  ],
                ),
                row([P2("Bài làm", at - 96)], [P2(t.essay ?? "", at - 95)]),
                row([P2("GV chữa", at - 94)], [P2(t.feedback || "", at)]),
              ],
            },
          };
        }),
      },
    },
  };
}

/** All text of a cell's paragraphs, joined. */
const cellText = (cell) =>
  cell.content
    .flatMap((p) =>
      (p.paragraph?.elements || []).map((e) => e.textRun?.content ?? ""),
    )
    .join("");

/** Every cell of a tab, in document order. */
const allCells = (tab) =>
  tab.documentTab.body.content.flatMap((block) =>
    block.table.tableRows.flatMap((r) => r.tableCells),
  );

/**
 * Applies insertText requests the way Docs would, for the layout above: an
 * insert at a cell's start index opens that cell, and each following insert
 * continues where the previous one ended. An insert right after the overall
 * label appends to it. Styling requests change no text and are ignored.
 */
function applyInserts(tab, requests) {
  let current = null; // { cell, end, text }
  const flush = () => {
    if (!current) return;
    const { cell, text, append, start } = current;
    if (append) {
      const el = cell.content[0].paragraph.elements[0].textRun;
      el.content = el.content.replace(/\n$/, "") + text + "\n";
    } else {
      cell.content = text.split("\n").map((line) => P(`${line}\n`, start));
    }
    current = null;
  };
  for (const request of requests) {
    if (!request.insertText) continue;
    const { index } = request.insertText.location;
    const text = request.insertText.text;
    if (current && current.end === index) {
      current.text += text;
      current.end += text.length;
      continue;
    }
    flush();
    const cell = allCells(tab).find((c) => {
      const start = c.content[0]?.startIndex;
      if (start === index) return true;
      const label = cellText(c).replace(/\n$/, "").trim();
      return (
        label.startsWith("Nhận xét chung") && start + label.length === index
      );
    });
    if (!cell) throw new Error(`fake docs: no cell at index ${index}`);
    const append = cell.content[0].startIndex !== index;
    current = { cell, start: index, end: index + text.length, text, append };
  }
  flush();
}

function createFakeDocs(tabsByDocId) {
  const docs = new Map(
    Object.entries(tabsByDocId).map(([id, tab]) => [id, { tab, rev: 1 }]),
  );
  const faults = []; // { op, docId, phase, error, times }
  const calls = { get: 0, batchUpdate: 0, applied: 0 };

  function fault(op, docId, phase) {
    const hit = faults.find(
      (f) =>
        f.op === op && f.phase === phase && (!f.docId || f.docId === docId),
    );
    if (!hit) return;
    hit.times -= 1;
    if (hit.times <= 0) faults.splice(faults.indexOf(hit), 1);
    // A function may only cause a side effect (a concurrent edit) and return
    // nothing, in which case the call proceeds normally.
    const error = typeof hit.error === "function" ? hit.error() : hit.error;
    if (error) throw error;
  }

  const entry = (docId) => {
    const doc = docs.get(docId);
    if (!doc) throw new DocsApiError(404, "not found");
    return doc;
  };

  return {
    docs,
    calls,
    /** Makes the next `times` calls of `op` fail. phase "after" = applied, then lost. */
    failNext(op, error, { docId, phase = "before", times = 1 } = {}) {
      faults.push({ op, docId, phase, error, times });
    },
    /** A teacher typing in the doc: changes it and its revision. */
    edit(docId, fn) {
      const doc = entry(docId);
      fn(doc.tab);
      doc.rev += 1;
    },
    async getDocument(docId) {
      calls.get += 1;
      await new Promise((r) => setImmediate(r));
      fault("get", docId, "before");
      const doc = entry(docId);
      return {
        revisionId: `r${doc.rev}`,
        tabs: [JSON.parse(JSON.stringify(doc.tab))],
      };
    },
    async getRevisionId(docId) {
      await new Promise((r) => setImmediate(r));
      return `r${entry(docId).rev}`;
    },
    async batchUpdate(docId, requests, _token, { requiredRevisionId } = {}) {
      calls.batchUpdate += 1;
      await new Promise((r) => setImmediate(r));
      fault("batchUpdate", docId, "before");
      const doc = entry(docId);
      if (requiredRevisionId && requiredRevisionId !== `r${doc.rev}`) {
        throw new DocsApiError(400, "The document was modified");
      }
      applyInserts(doc.tab, requests);
      doc.rev += 1;
      calls.applied += 1;
      fault("batchUpdate", docId, "after");
      return `r${doc.rev}`;
    },
    /** Every non-empty feedback cell's text, by docId. */
    feedbackOf(docId) {
      const rows = entry(docId).tab.documentTab.body.content[0].table.tableRows;
      return rows.slice(2).map((r) => cellText(r.tableCells[2]).trim());
    },
    overallOf(docId) {
      return cellText(
        entry(docId).tab.documentTab.body.content.at(-1).table.tableRows[0]
          .tableCells[0],
      ).trim();
    },
    /** IELTS table `i`'s "GV chữa" cell (makeIeltsTab), blank lines kept. */
    ieltsFeedbackOf(docId, i = 0) {
      return cellText(
        entry(docId).tab.documentTab.body.content[i].table.tableRows[3]
          .tableCells[1],
      ).replace(/\n$/, "");
    },
    /** The paragraph table's "GV sửa" cell, blank lines kept. */
    paragraphFeedbackOf(docId) {
      return cellText(
        entry(docId).tab.documentTab.body.content[1].table.tableRows[2]
          .tableCells[2],
      ).replace(/\n$/, "");
    },
  };
}

/**
 * A queue the test drives: tasks wait until `drain()` (one at a time, a thrown
 * task goes back to the end — Cloud Tasks retrying) or `runAll()` (every
 * queued task at once — duplicate / concurrent delivery).
 */
function createManualQueue() {
  const names = new Set();
  const pending = [];
  const log = [];
  return {
    names,
    pending,
    log,
    async enqueue(name, payload) {
      if (names.has(name)) return { created: false };
      names.add(name);
      pending.push({ name, payload, attempts: 0 });
      return { created: true };
    },
    async drain(handler, { maxAttempts = 8 } = {}) {
      while (pending.length) {
        const task = pending.shift();
        task.attempts += 1;
        try {
          await handler(task.payload);
          log.push({ name: task.name, ok: true });
        } catch (err) {
          log.push({ name: task.name, ok: false, error: err.message });
          if (task.attempts < maxAttempts) pending.push(task);
        }
      }
    },
  };
}

/**
 * Builds a job service over fresh fakes. Seeds a class, a lesson, a teacher
 * with `points`, and one student per entry of `tabs`.
 */
function createHarness({
  tabs,
  points = 100,
  isAdminTeacher = false,
  startAt = 1_000_000,
  gradingProfile = "basic",
  ieltsEnabled = true,
} = {}) {
  const db = new FakeFirestore();
  const admin = createFakeAdmin();
  let clock = startAt;
  const now = () => clock;

  const seed = (col, id, data) =>
    db._apply({ type: "set", path: `${col}/${id}`, data });
  seed("classes", "c1", {
    name: "Lớp A",
    classType: "basic_since_01042026",
    teacherId: ["t1"],
  });
  seed("lesson", "l10", { name: LESSON });
  seed("teachers", "t1", { gmail: "teacher@x.com", name: "Cô Hà" });
  seed("TeacherPoint", "t1", { point: points });
  Object.keys(tabs).forEach((docId, i) =>
    seed("students", `s${i}`, {
      classId: "c1",
      name: `HS ${i}`,
      ggDocLink: `https://docs.google.com/document/d/${docId}/edit`,
    }),
  );

  const docsApi = createFakeDocs(tabs);
  const queue = createManualQueue();
  const counters = {
    grade: 0,
    summary: 0,
    notify: 0,
    push: 0,
    consume: 0,
    tokenCalls: 0,
    gradedItems: [], // every item handed to gradeItems
    ielts: 0, // gradeIelts calls
    ieltsInputs: [], // every validated IELTS submission graded
    images: [], // every chart uri downloaded
  };
  const hooks = {
    gradeGate: null, // Promise the next grade call waits on
    beforeConsume: null, // async ({docId}) => void, may throw
    afterConsume: null,
    tokenError: null, // () => Error | null, per getDocsAccessToken call
    noStoredToken: false, // the Google user never had a token stored
    // () => the grading-schedule service, when a test wires one in (the same
    // delegation server.js does through scheduleAwareOnFinished).
    schedules: null,
    paragraphFeedback: PARAGRAPH_FEEDBACK, // what the AI says about a paragraph
    ieltsFeedback: IELTS_FEEDBACK, // what the AI says about an IELTS essay
    ieltsFail: null, // (input) => Error | null — the IELTS grader fails
    imageFail: null, // (uri) => boolean — a chart download fails
  };
  const finished = [];

  const tokens = {
    hasRefreshToken: async () => !hooks.noStoredToken,
    invalidate: () => {},
    async getDocsAccessToken() {
      counters.tokenCalls += 1;
      const err = hooks.tokenError?.(counters.tokenCalls);
      if (err) throw err;
      return { token: "tok", isServiceAccount: false };
    },
  };

  const jobs = createGradingJobs({
    db,
    admin,
    docsApi,
    tokens,
    loadDocLib: () =>
      Promise.all([
        import("../../lib/doc/docParser.js"),
        import("../../lib/doc/docTableDetect.js"),
        import("../../lib/doc/docWriter.js"),
        import("../../lib/doc/ieltsDoc.js"),
      ]).then((modules) => Object.assign({}, ...modules)),
    gradingProfileOfClass: async () => gradingProfile,
    ieltsEnabled,
    async gradeIelts(input) {
      counters.ielts += 1;
      counters.ieltsInputs.push(input);
      const error = hooks.ieltsFail?.(input);
      if (error) throw error;
      return { feedback: hooks.ieltsFeedback };
    },
    async fetchImage(uri, token) {
      counters.images.push({ uri, token });
      if (hooks.imageFail?.(uri)) throw new Error("image_http_403");
      return { mime: "image/png", buffer: Buffer.from(`png:${uri}`) };
    },
    async gradeItems(items) {
      counters.grade += 1;
      if (hooks.gradeGate) {
        const gate = hooks.gradeGate;
        hooks.gradeGate = null;
        await gate;
      }
      counters.gradedItems.push(...items);
      // "ok" answers are right; anything else gets a bold correction + reason.
      // A paragraph gets what lib/paragraphFeedback.js produces: already laid
      // out on several lines (null = the AI left it out).
      return items.map((item) => ({
        ...item,
        feedback:
          item.taskType === "paragraph"
            ? hooks.paragraphFeedback
            : /ok/i.test(item.answer)
              ? "✅ Đúng"
              : `She **has done** it. (Sai thì.)`,
      }));
    },
    async consumePoints(charge) {
      counters.consume += 1;
      await hooks.beforeConsume?.(charge);
      const result = await consumePointsForDocs(db, admin, charge);
      await hooks.afterConsume?.(charge, result);
      return result;
    },
    async resolvePayer(email) {
      if (email === "admin@x.com" || isAdminTeacher) {
        return { id: "t1", gmail: "teacher@x.com", name: "Cô Hà" };
      }
      return email === "teacher@x.com"
        ? { id: "t1", gmail: "teacher@x.com", name: "Cô Hà" }
        : null;
    },
    enqueue: (name, payload) => queue.enqueue(name, payload),
    onFinished: scheduleAwareOnFinished(
      {
        async recordSummary(job) {
          counters.summary += 1;
          finished.push({ kind: "summary", job });
        },
        async notify(job) {
          counters.notify += 1;
          finished.push({ kind: "notify", job });
        },
        async push() {
          counters.push += 1;
        },
      },
      () => hooks.schedules(),
    ),
    now,
  });

  const start = (overrides = {}) =>
    jobs.createJob({
      email: "teacher@x.com",
      authKind: "google",
      isAdmin: false,
      classId: "c1",
      lessonId: "l10",
      ...overrides,
    });

  return {
    db,
    admin,
    docsApi,
    queue,
    counters,
    hooks,
    finished,
    jobs,
    start,
    drain: (opts) => queue.drain((p) => jobs.handleTask(p), opts),
    advance: (ms) => {
      clock += ms;
    },
    now,
    setClock: (ms) => {
      clock = ms;
    },
    job: (jobId) => db.dump("gradingJobs")[jobId],
    docRecords: (jobId) => db.dump(`gradingJobs/${jobId}/docs`),
    points: () => db.dump("TeacherPoint").t1.point,
    ledger: () => Object.values(db.dump("TeacherPointLedger")),
  };
}

module.exports = {
  IELTS_FEEDBACK,
  LESSON,
  P,
  PARAGRAPH_FEEDBACK,
  createFakeDocs,
  createHarness,
  makeIeltsTab,
  makeTab,
  row,
};
