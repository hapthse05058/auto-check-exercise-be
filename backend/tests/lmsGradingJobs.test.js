const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createLmsGradingJobs,
  GRADER_VERSION,
  STUDENT_STATUS: S,
} = require("../lib/lmsGradingJobs.js");
const { RetryLater } = require("../lib/gradingJobs.js");
const { LmsError } = require("../lib/lms/lmsClient.js");
const {
  consumePointsForDocs,
  readBalanceVnd,
} = require("../lib/teacherPoints.js");
const {
  FakeFirestore,
  createFakeAdmin,
} = require("./helpers/fakeFirestore.js");
const {
  createFakeLms,
  doc,
  reportRow,
  sessionPage,
} = require("./helpers/lmsFixtures.js");

const TEACHER = { id: "t1", name: "GV A", gmail: "gva@example.com" };
const PRICE = 800;

function loadDocLib() {
  return Promise.all([
    import("../lib/doc/docParser.js"),
    import("../lib/doc/docTableDetect.js"),
    import("../lib/doc/docWriter.js"),
  ]).then((mods) => Object.assign({}, ...mods));
}

/**
 * The job over a fake LMS, a real FakeFirestore and the real billing code.
 * The queue is driven by hand: drain() runs queued tasks, re-queueing a
 * RetryLater like Cloud Tasks would.
 */
function harness({
  rows,
  pages,
  balanceVnd = 100000,
  writeEnabled = true,
  hooks = {},
  accountStatus = { linked: true, status: "ok" },
} = {}) {
  const db = new FakeFirestore();
  const admin = createFakeAdmin();
  const lms = createFakeLms({
    rows: rows || [
      reportRow(101, "An Nguyễn", 4),
      reportRow(102, "Bình Trần", 4),
      reportRow(103, "Chi Lê", null, { ordering: null }), // not submitted
      reportRow(104, "Dũng Phạm", 2), // teacher already graded
    ],
    pages: pages || {
      101: sessionPage(),
      102: sessionPage({
        answers: ["x good", "y good", "z good", "w good", "v good"],
        orderingAnswer: "Long speaks clearly good",
      }),
      104: sessionPage({ writingStatus: 2 }),
    },
    hooks,
  });
  const queue = [];
  const graded = [];
  const extraGraded = [];
  const state = { writeEnabled };
  const jobs = createLmsGradingJobs({
    db,
    admin,
    lmsClient: {
      forTeacher: (source) =>
        source.teacherId === "t-no-class"
          ? { ...lms.api, listClasses: async () => [] }
          : lms.api,
    },
    lmsAccounts: {
      status: async () => accountStatus,
      tokenSource: (teacherId) => ({ teacherId }),
    },
    loadDocLib,
    gradeItems: async (items) => {
      graded.push(...items);
      return items.map((i) => ({
        ...i,
        feedback: /good/.test(i.answer)
          ? "✅ Đúng"
          : "I **am learning** English now. (Sai thì HTTD.)",
      }));
    },
    gradeExtra: async (items) => {
      extraGraded.push(...items);
      return items.map((i) =>
        /good/.test(i.answer)
          ? "✅ Đúng"
          : "Long speaks **clearly**.\n(Trạng từ đứng sau động từ.)",
      );
    },
    consumePoints: (args) => consumePointsForDocs(db, admin, args),
    readBalanceVnd: (id) => readBalanceVnd(db, id),
    enqueue: async (name, payload) => {
      if (queue.some((t) => t.name === name)) return { created: false };
      queue.push({ name, payload });
      return { created: true };
    },
    writeEnabled: () => state.writeEnabled,
    now: () => Date.UTC(2026, 10, 6, 3),
  });
  async function drain(max = 50) {
    const retried = [];
    for (let i = 0; i < max && queue.length; i++) {
      const task = queue.shift();
      try {
        await jobs.handleTask(task.payload);
      } catch (err) {
        if (!(err instanceof RetryLater)) throw err;
        retried.push(err.message);
        queue.push(task);
      }
    }
    return retried;
  }
  const seed = () =>
    db
      .collection("TeacherPoint")
      .doc(TEACHER.id)
      .set({ teacherId: TEACHER.id, balanceVnd });
  return { db, lms, jobs, queue, drain, graded, extraGraded, seed, state };
}

async function gradedJob(h) {
  await h.seed();
  const { jobId } = await h.jobs.createJob({
    teacher: TEACHER,
    email: TEACHER.gmail,
    classId: 7,
    sessionId: 477,
    unitPriceVnd: PRICE,
  });
  await h.drain();
  return jobId;
}

const studentsOf = async (h, jobId) =>
  Object.fromEntries(
    (
      await h.jobs.getJob(jobId, {
        email: TEACHER.gmail,
        teacherId: TEACHER.id,
      })
    ).students.map((s) => [s.studentId, s]),
  );

const balance = (h) => readBalanceVnd(h.db, TEACHER.id);

describe("prepare", () => {
  test("grades submitted students, explains every skip, writes nothing", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    const { job } = await h.jobs.getJob(jobId, { email: TEACHER.gmail });
    assert.equal(job.status, "graded");
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.GRADED);
    assert.equal(st[102].status, S.GRADED);
    assert.equal(st[103].status, S.SKIPPED);
    assert.equal(st[103].reason, "notSubmitted");
    assert.equal(st[104].status, S.TEACHER_GRADED);
    // 101: writing 3 right, 1 wrong, 1 blank (skipped) + word order wrong
    // → 3/5 → 60% → 3. Spelling was not submitted: not graded, not counted.
    // 102 all right → 5.
    assert.equal(st[101].score, 3);
    assert.equal(st[101].counted, 5);
    assert.deepEqual(st[101].counts, {
      supported: 5,
      blank: 1,
      excluded: 2,
      uncertain: 0,
    });
    assert.equal(st[102].score, 5);
    // Word order went to the extra grader with its words, spelling did not.
    assert.deepEqual(
      h.extraGraded.map((i) => i.kind),
      ["word_order", "word_order"],
    );
    assert.equal(h.extraGraded[0].question, "speaks / Long / clearly / .");
    // The never-graded "BÀI TẬP NGHE" stays out.
    assert.ok(!st[101].questions.some((q) => q.assignmentId === 1476));
    // Formula rows were never sent to the AI.
    assert.ok(!h.graded.some((i) => /^HTĐ$|B1:/.test(i.question)));
    // Identical answers across students graded once.
    assert.equal(new Set(h.graded.map((i) => i.answer)).size, h.graded.length);
    assert.equal(h.lms.state.puts.length, 0);
    assert.equal(await balance(h), 100000);
    // Secrets of the fingerprinting are not exposed.
    assert.equal(st[101].draftHash, undefined);
  });

  test("a student with reviews we did not write is skipped (teacher started)", async () => {
    const h = harness({
      rows: [reportRow(101, "An", 4)],
      pages: {
        101: sessionPage({ writingReview: { "q-w2": doc("Cô đã chữa") } }),
      },
    });
    const jobId = await gradedJob(h);
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.SKIPPED);
    assert.equal(st[101].reason, "teacherStarted");
  });

  test("not enough balance: fails before any AI call", async () => {
    const h = harness({ balanceVnd: 900 }); // 2 students × 800 needed
    const jobId = await gradedJob(h);
    const { job } = await h.jobs.getJob(jobId, { email: TEACHER.gmail });
    assert.equal(job.status, "failed");
    assert.equal(job.error, "not_enough_points");
    assert.equal(h.graded.length, 0);
  });

  test("only the teacher's KTN classes and started sessions", async () => {
    const h = harness();
    await h.seed();
    const base = {
      teacher: TEACHER,
      email: TEACHER.gmail,
      unitPriceVnd: PRICE,
    };
    await assert.rejects(
      h.jobs.createJob({ ...base, classId: 9, sessionId: 477 }),
      (e) => e.code === "lms_class_not_found",
    );
    await assert.rejects(
      h.jobs.createJob({ ...base, classId: 7, sessionId: 999 }),
      (e) => e.code === "lms_session_not_found",
    );
    await assert.rejects(
      h.jobs.createJob({ ...base, classId: 7, sessionId: 478 }),
      (e) => e.code === "lms_session_not_started",
    );
  });

  test("an unlinked LMS account cannot start a job", async () => {
    const h = harness({ accountStatus: { linked: false } });
    await assert.rejects(
      h.jobs.createJob({
        teacher: TEACHER,
        email: TEACHER.gmail,
        classId: 7,
        sessionId: 477,
        unitPriceVnd: PRICE,
      }),
      (e) => e.code === "lms_not_linked",
    );
  });

  test("two concurrent starts: exactly one job", async () => {
    const h = harness();
    await h.seed();
    const start = () =>
      h.jobs.createJob({
        teacher: TEACHER,
        email: TEACHER.gmail,
        classId: 7,
        sessionId: 477,
        unitPriceVnd: PRICE,
      });
    const results = await Promise.allSettled([start(), start()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "job_in_progress",
    );
  });
});

describe("write (Lưu nháp)", () => {
  test("saves a draft of the submitted graded assignments only, charges once", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101", "102", "103"],
    });
    await h.drain();
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.DRAFT_SAVED);
    assert.equal(st[102].status, S.DRAFT_SAVED);
    assert.equal(st[103].status, S.SKIPPED); // not selectable: untouched
    assert.equal(h.lms.state.puts.length, 2);
    // Writing + word order (submitted); not spelling (not submitted), not
    // the never-graded listening assignment.
    for (const put of h.lms.state.puts) {
      assert.deepEqual(
        put.body.map((b) => b.assignmentId),
        [1472, 1473],
      );
    }
    assert.equal(await balance(h), 100000 - 2 * PRICE);
    const { job } = await h.jobs.getJob(jobId, { email: TEACHER.gmail });
    assert.equal(job.status, "graded");
    assert.equal(job.written, 2);
    assert.equal(job.charged, 2);
    // The LMS page now carries the draft: the shared score on both.
    const page = h.lms.state.pages.get("101");
    assert.equal(page[0].score, 3);
    assert.equal(page[1].score, 3);
    assert.equal(page[2].score, 0); // spelling untouched
    const listening =
      page[3].gradingList.questionGroupList[0].questionGroup[0].questionList[0];
    assert.equal(listening.review, doc("Tốt")); // the teacher's, untouched
    // Running the same tasks again changes nothing.
    await h.jobs.handleTask({
      kind: "lms",
      step: "write",
      jobId,
      studentId: "101",
      round: 1,
    });
    assert.equal(h.lms.state.puts.length, 2);
    assert.equal(await balance(h), 100000 - 2 * PRICE);
  });

  test("Test B: the teacher edits a review before the write → not overwritten", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    const q =
      h.lms.state.pages.get("101")[0].gradingList.questionGroupList[2]
        .questionGroup[0].questionList[1];
    q.review = doc("Cô chữa tay");
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.TEACHER_MODIFIED);
    assert.equal(h.lms.state.puts.length, 0);
    assert.equal(await balance(h), 100000);
  });

  test("Test B': the teacher edits our draft afterwards → a re-run never overwrites", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    const q =
      h.lms.state.pages.get("101")[0].gradingList.questionGroupList[2]
        .questionGroup[0].questionList[1];
    q.review = doc("Cô sửa lại nhận xét của AI");
    // A new job sees reviews that are neither empty nor our draft.
    const { jobId: second } = await h.jobs.createJob({
      teacher: TEACHER,
      email: TEACHER.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    const st = await studentsOf(h, second);
    assert.equal(st[101].status, S.SKIPPED);
    assert.equal(st[101].reason, "teacherStarted");
  });

  test("Test C: the PUT lands but the answer is lost → no second PUT, one charge", async () => {
    let lose = true;
    const h = harness({
      hooks: {
        afterPut: async () => {
          if (lose) {
            lose = false;
            throw new LmsError("write_uncertain");
          }
        },
      },
    });
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    const retried = await h.drain();
    assert.deepEqual(retried, ["write_uncertain"]);
    assert.equal(h.lms.state.puts.length, 1);
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.DRAFT_SAVED);
    assert.equal(await balance(h), 100000 - PRICE);
  });

  test("the student edits an answer after grading → changed, not written", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    // Row 4 of the translation group is q-w3 (row 3 is the "HTTD" heading).
    const q =
      h.lms.state.pages.get("101")[0].gradingList.questionGroupList[2]
        .questionGroup[0].questionList[4];
    assert.equal(q.id, "q-w3");
    q.selectedAnswer[0].content[0].source = doc(
      "I am learning English now good",
    );
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.CHANGED);
    assert.equal(h.lms.state.puts.length, 0);
  });

  test("the teacher grades on the LMS in between → teacher_graded, not written", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    h.lms.state.pages.get("101")[0].gradingStatus = 2;
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    assert.equal((await studentsOf(h, jobId))[101].status, S.TEACHER_GRADED);
    assert.equal(h.lms.state.puts.length, 0);
  });

  test("balance gone before the write → insufficient_points, no PUT", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.db
      .collection("TeacherPoint")
      .doc(TEACHER.id)
      .set({ teacherId: TEACHER.id, balanceVnd: 100 });
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    assert.equal((await studentsOf(h, jobId))[101].status, S.INSUFFICIENT);
    assert.equal(h.lms.state.puts.length, 0);
  });

  test("a later job recognises our own draft and does not grade it again", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    const gradedBefore = h.graded.length;
    const { jobId: second } = await h.jobs.createJob({
      teacher: TEACHER,
      email: TEACHER.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    const st = await studentsOf(h, second);
    assert.equal(st[101].status, S.DRAFT_SAVED);
    assert.equal(st[102].status, S.GRADED);
    // Only 102's answers were sent again; none of 101's.
    const again = h.graded.slice(gradedBefore).map((i) => i.answer);
    assert.deepEqual(again.sort(), [
      "v good",
      "w good",
      "x good",
      "y good",
      "z good",
    ]);
  });

  test("a superseded job can no longer save drafts", async () => {
    const h = harness();
    const first = await gradedJob(h);
    await h.jobs.createJob({
      teacher: TEACHER,
      email: TEACHER.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    await assert.rejects(
      h.jobs.startWrite({
        jobId: first,
        email: TEACHER.gmail,
        studentIds: ["101"],
      }),
      (e) => e.code === "job_superseded",
    );
  });

  test("kill switch: writes refused while LMS_WRITE_ENABLED is off", async () => {
    const h = harness({ writeEnabled: false });
    const jobId = await gradedJob(h);
    await assert.rejects(
      h.jobs.startWrite({ jobId, email: TEACHER.gmail, studentIds: ["101"] }),
      (e) => e.code === "lms_write_disabled",
    );
    // Results stay readable.
    const { job } = await h.jobs.getJob(jobId, { email: TEACHER.gmail });
    assert.equal(job.status, "graded");
    assert.equal(job.writeEnabled, false);
  });

  test("switched off mid-round: queued students fail without a PUT", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    h.state.writeEnabled = false;
    await h.drain();
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.WRITE_FAILED);
    assert.equal(st[101].reason, "writeDisabled");
    assert.equal(h.lms.state.puts.length, 0);
  });
});

describe("access", () => {
  test("another teacher can neither read nor write the job", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await assert.rejects(
      h.jobs.getJob(jobId, { email: "other@example.com" }),
      (e) => e.code === "forbidden",
    );
    await assert.rejects(
      h.jobs.startWrite({
        jobId,
        email: "other@example.com",
        studentIds: ["101"],
      }),
      (e) => e.code === "forbidden",
    );
    // An admin may read it.
    const { job } = await h.jobs.getJob(jobId, {
      email: "admin@example.com",
      isAdmin: true,
    });
    assert.equal(job.id, jobId);
  });
});

describe("assignments submitted later (word order / spelling)", () => {
  const L = require("../lib/lms/lmsItems.js");
  const reviewsOf = (page, assignmentIndex) =>
    page[assignmentIndex].gradingList.questionGroupList
      .flatMap((g) => g.questionGroup.flatMap((x) => x.questionList))
      .filter((q) => q.type === 2)
      .map((q) => L.tiptapToText(q.review, { markBold: true }));

  async function writeAll(h, jobId, ids) {
    await h.jobs.startWrite({ jobId, email: TEACHER.gmail, studentIds: ids });
    await h.drain();
  }

  test("a first-version draft (writing only) is reused, the new assignment graded, no second charge", async () => {
    // Day 1: the student had only submitted writing.
    const rows = [reportRow(101, "An", 4, { ordering: null })];
    const h = harness({ rows, pages: { 101: sessionPage() } });
    const first = await gradedJob(h);
    await writeAll(h, first, ["101"]);
    assert.equal(h.lms.state.puts.length, 1);
    assert.deepEqual(
      h.lms.state.puts[0].body.map((b) => b.assignmentId),
      [1472],
    );
    const writingReviews = reviewsOf(h.lms.state.pages.get("101"), 0);
    // Rewrite the record the way the first version stored it.
    const draftDoc = h.db.collection("lmsDrafts").doc("7_477_101");
    const rec = (await draftDoc.get()).data();
    await draftDoc.set({
      jobId: rec.jobId,
      draftHash: rec.assignments["1472"].reviewHash,
      answerHash: rec.assignments["1472"].answerHash,
      graderVersion: GRADER_VERSION, // the record format is what is tested
    });
    const paid = await balance(h);

    // Later: word order submitted too.
    h.lms.state.rows = [reportRow(101, "An", 4, { ordering: 4 })];
    const writingGraded = h.graded.length;
    const { jobId: second } = await h.jobs.createJob({
      teacher: TEACHER,
      email: TEACHER.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    const st = (await studentsOf(h, second))[101];
    assert.equal(st.status, S.GRADED);
    assert.deepEqual(st.reusedAssignmentIds, ["1472"]);
    assert.equal(h.graded.length, writingGraded); // writing NOT sent to the AI again
    assert.ok(
      st.questions
        .filter((q) => q.assignmentId === 1472 && q.review)
        .every((q) => q.reused),
    );
    // Score now covers both: writing 3/4 + word order wrong → 3/5 → 3.
    assert.equal(st.score, 3);

    await writeAll(h, second, ["101"]);
    assert.equal((await studentsOf(h, second))[101].status, S.DRAFT_SAVED);
    const last = h.lms.state.puts.at(-1).body;
    assert.deepEqual(
      last.map((b) => b.assignmentId),
      [1472, 1473],
    );
    const page = h.lms.state.pages.get("101");
    // Writing reviews identical (bold kept); word order now reviewed.
    assert.deepEqual(reviewsOf(page, 0), writingReviews);
    assert.match(reviewsOf(page, 1)[0], /\*\*clearly\*\*/);
    assert.equal(page[0].score, 3);
    // One student, one session: charged once.
    assert.equal(await balance(h), paid);
  });

  test("a draft that marked blanks 'Chưa làm' is offered again: blanks cleared, score redone, no new AI call or charge", async () => {
    const rows = [reportRow(101, "An", 4, { ordering: null })];
    const h = harness({ rows, pages: { 101: sessionPage() } });
    const first = await gradedJob(h);
    await writeAll(h, first, ["101"]);
    // Make the saved draft look like the first version's: "Chưa làm" on the
    // blank question, and its hash recorded as ours.
    const questionsOf = (pg) =>
      pg[0].gradingList.questionGroupList.flatMap((g) =>
        g.questionGroup.flatMap((x) => x.questionList),
      );
    const page = h.lms.state.pages.get("101");
    questionsOf(page).find((q) => q.id === "q-w5").review = L.reviewToTiptap(
      L.BLANK_REVIEW,
    );
    const keys = L.itemsFromGrading(page)
      .questions.filter((q) => L.isWritten(q) && q.assignmentId === 1472)
      .map((q) => q.key);
    const draftDoc = h.db.collection("lmsDrafts").doc("7_477_101");
    const rec = (await draftDoc.get()).data();
    rec.assignments["1472"].reviewHash = L.hashReviews(page, keys);
    await draftDoc.set(rec);
    const paid = await balance(h);
    const aiCalls = h.graded.length;

    const newJob = async () => {
      const { jobId } = await h.jobs.createJob({
        teacher: TEACHER,
        email: TEACHER.gmail,
        classId: 7,
        sessionId: 477,
        unitPriceVnd: PRICE,
      });
      await h.drain();
      return jobId;
    };
    const second = await newJob();
    const st = (await studentsOf(h, second))[101];
    assert.equal(st.status, S.GRADED);
    assert.deepEqual(st.reusedAssignmentIds, ["1472"]);
    assert.equal(h.graded.length, aiCalls);
    assert.equal(st.counted, 4); // 3 right of 4 answered, the blank skipped
    assert.equal(st.score, 3);

    await writeAll(h, second, ["101"]);
    assert.equal((await studentsOf(h, second))[101].status, S.DRAFT_SAVED);
    const after = h.lms.state.pages.get("101");
    const cleared = questionsOf(after).find((q) => q.id === "q-w5");
    assert.equal(L.tiptapToText(cleared.review), "");
    assert.equal(await balance(h), paid);

    // The run after that sees the corrected draft as done.
    const third = await newJob();
    assert.equal((await studentsOf(h, third))[101].status, S.DRAFT_SAVED);
  });

  test("a draft from an older grader is ours but graded again, charged once", async () => {
    const h = harness({
      rows: [reportRow(101, "An", 4)],
      pages: { 101: sessionPage() },
    });
    const first = await gradedJob(h);
    await writeAll(h, first, ["101"]);
    const draftDoc = h.db.collection("lmsDrafts").doc("7_477_101");
    const rec = (await draftDoc.get()).data();
    delete rec.graderVersion; // saved before versions existed
    await draftDoc.set(rec);
    const paid = await balance(h);
    const aiCalls = [h.graded.length, h.extraGraded.length];
    const { jobId } = await h.jobs.createJob({
      teacher: TEACHER,
      email: TEACHER.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    const st = (await studentsOf(h, jobId))[101];
    assert.equal(st.status, S.GRADED); // not "teacherStarted", not reused
    assert.deepEqual(st.reusedAssignmentIds, []);
    assert.ok(h.graded.length > aiCalls[0]);
    await writeAll(h, jobId, ["101"]);
    assert.equal((await studentsOf(h, jobId))[101].status, S.DRAFT_SAVED);
    assert.equal(await balance(h), paid);
  });

  test("a third run finds everything drafted and grades nothing", async () => {
    const h = harness({
      rows: [reportRow(101, "An", 4)],
      pages: { 101: sessionPage() },
    });
    const first = await gradedJob(h);
    await writeAll(h, first, ["101"]);
    const before = [h.graded.length, h.extraGraded.length];
    const { jobId } = await h.jobs.createJob({
      teacher: TEACHER,
      email: TEACHER.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    assert.equal((await studentsOf(h, jobId))[101].status, S.DRAFT_SAVED);
    assert.deepEqual([h.graded.length, h.extraGraded.length], before);
  });

  test("the teacher reviewed the word order by hand → the student is left alone", async () => {
    const h = harness({
      rows: [reportRow(101, "An", 4)],
      pages: { 101: sessionPage() },
    });
    const q =
      h.lms.state.pages.get("101")[1].gradingList.questionGroupList[0]
        .questionGroup[0].questionList[0];
    q.review = doc("Cô chấm rồi");
    const jobId = await gradedJob(h);
    const st = (await studentsOf(h, jobId))[101];
    assert.equal(st.status, S.SKIPPED);
    assert.equal(st.reason, "teacherStarted");
  });
});

describe("read-only views", () => {
  test("class overview: held sessions only, status per assignment, tool drafts flagged", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    const o = await h.jobs.classOverview(TEACHER.id, 7);
    // Buổi 5 starts in 2099: not listed.
    assert.deepEqual(
      o.sessions.map((s) => s.id),
      [477],
    );
    assert.deepEqual(
      o.students.map((s) => s.fullName),
      ["An Nguyễn", "Bình Trần", "Chi Lê", "Dũng Phạm"],
    );
    const cell = (id) => o.cells["477"][id];
    const writing = (id) =>
      cell(id).assignments.find((a) => a.assignmentId === 1472);
    assert.equal(writing("101").status, "submitted");
    assert.equal(writing("103").status, "notSubmitted");
    assert.equal(writing("104").status, "graded");
    assert.equal(cell("101").toolDraft, true);
    assert.equal(cell("102").toolDraft, undefined);
    assert.equal(h.lms.state.puts.length, 1); // the overview wrote nothing
  });

  test("class overview of a class that is not the teacher's KTN class: 404", async () => {
    const h = harness();
    await assert.rejects(h.jobs.classOverview(TEACHER.id, 9), (e) =>
      /lms_class_not_found/.test(e.code || e.message),
    );
  });

  test("student work: every assignment with answers, reviews (bold kept) and marks", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await h.jobs.startWrite({
      jobId,
      email: TEACHER.gmail,
      studentIds: ["101"],
    });
    await h.drain();
    const puts = h.lms.state.puts.length;
    const w = await h.jobs.studentWork(TEACHER.id, 7, 477, 101);
    assert.equal(w.toolDraft, true);
    assert.match(w.lmsUrl, /\/session\/477\/grading\/101\/assignment$/);
    const ids = w.assignments.map((a) => a.assignmentId);
    assert.ok(ids.includes(1472) && ids.includes(1473));
    const writing = w.assignments.find((a) => a.assignmentId === 1472);
    assert.ok(writing.questions.length > 0);
    const wrong = writing.questions.find(
      (q) => q.isCorrect === false && q.review,
    );
    assert.match(wrong.review, /\*\*am learning\*\*/);
    assert.ok(writing.questions.some((q) => q.isCorrect === true));
    assert.equal(h.lms.state.puts.length, puts); // read-only
  });
});

describe("a session shared by the class's teachers", () => {
  const OTHER = { id: "t-b", name: "GV B", gmail: "b@example.com" };
  const asOther = { email: OTHER.gmail, teacherId: OTHER.id };
  const fund = (h, teacher, balanceVnd) =>
    h.db
      .collection("TeacherPoint")
      .doc(teacher.id)
      .set({ teacherId: teacher.id, balanceVnd });
  const balanceOf = (h, teacher) => readBalanceVnd(h.db, teacher.id);
  const saveAs = async (h, jobId, teacher, studentIds) => {
    await h.jobs.startWrite({
      jobId,
      email: teacher.gmail,
      teacherId: teacher.id,
      teacher,
      studentIds,
    });
    await h.drain();
  };
  const newJob = async (h, teacher) => {
    const { jobId } = await h.jobs.createJob({
      teacher,
      email: teacher.gmail,
      classId: 7,
      sessionId: 477,
      unitPriceVnd: PRICE,
    });
    await h.drain();
    return jobId;
  };

  test("another teacher of the class sees the results, and pays for what they save", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await fund(h, OTHER, 5000);
    const before = await balance(h);

    const seen = await h.jobs.latestJob("7", "477", asOther);
    assert.equal(seen.job.id, jobId);
    assert.equal(
      seen.students.find((x) => x.studentId === "101").status,
      S.GRADED,
    );

    await saveAs(h, jobId, OTHER, ["101"]);
    const st = await studentsOf(h, jobId);
    assert.equal(st[101].status, S.DRAFT_SAVED);
    assert.equal(await balanceOf(h, OTHER), 5000 - PRICE);
    assert.equal(await balance(h), before); // the teacher who ran it: untouched
  });

  test("a student already paid for is not billed again when another teacher saves", async () => {
    const h = harness();
    const first = await gradedJob(h);
    await saveAs(h, first, TEACHER, ["101"]);
    const paid = await balance(h);
    await fund(h, OTHER, 5000);
    // Saved by an older grader: the next run grades it again.
    const draftDoc = h.db.collection("lmsDrafts").doc("7_477_101");
    const rec = (await draftDoc.get()).data();
    assert.equal(rec.paidBy.id, TEACHER.id);
    delete rec.graderVersion;
    await draftDoc.set(rec);

    const second = await newJob(h, OTHER);
    assert.equal((await studentsOf(h, second))[101].status, S.GRADED);
    await saveAs(h, second, OTHER, ["101"]);
    assert.equal((await studentsOf(h, second))[101].status, S.DRAFT_SAVED);
    assert.equal(await balanceOf(h, OTHER), 5000);
    assert.equal(await balance(h), paid);
  });

  test("the same, for a draft saved before paidBy was recorded", async () => {
    const h = harness();
    const first = await gradedJob(h);
    await saveAs(h, first, TEACHER, ["101"]);
    const paid = await balance(h);
    await fund(h, OTHER, 5000);
    const draftDoc = h.db.collection("lmsDrafts").doc("7_477_101");
    const rec = (await draftDoc.get()).data();
    delete rec.graderVersion;
    delete rec.paidBy;
    await draftDoc.set(rec);

    const second = await newJob(h, OTHER);
    await saveAs(h, second, OTHER, ["101"]);
    assert.equal(await balanceOf(h, OTHER), 5000);
    assert.equal(await balance(h), paid);
  });

  test("a teacher the LMS does not list on the class sees nothing", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    const outsider = { email: "x@example.com", teacherId: "t-no-class" };
    await assert.rejects(
      h.jobs.getJob(jobId, outsider),
      (e) => e.code === "forbidden",
    );
    assert.equal(await h.jobs.latestJob("7", "477", outsider), null);
    await assert.rejects(
      h.jobs.startWrite({ jobId, ...outsider, studentIds: ["101"] }),
      (e) => e.code === "forbidden",
    );
  });

  test("a new run that fails puts the previous results back, still savable", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await fund(h, OTHER, 0);

    const failed = await newJob(h, OTHER);
    const { job } = await h.jobs.getJob(failed, asOther);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "not_enough_points");
    assert.equal(job.restoredJobId, jobId);

    const back = await h.jobs.latestJob("7", "477", { email: TEACHER.gmail });
    assert.equal(back.job.id, jobId);
    assert.equal(back.job.status, "graded");
    await saveAs(h, jobId, TEACHER, ["101"]);
    assert.equal((await studentsOf(h, jobId))[101].status, S.DRAFT_SAVED);
  });

  test("the preview counts students the tool has drafted apart from those to grade", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    const before = await h.jobs.preview(TEACHER.id, 7, 477, PRICE);
    assert.equal(before.counts.candidate, 2);
    assert.equal(before.counts.toolDraft, 0);
    await saveAs(h, jobId, TEACHER, ["101"]);
    const after = await h.jobs.preview(TEACHER.id, 7, 477, PRICE);
    assert.equal(after.counts.candidate, 1);
    assert.equal(after.counts.toolDraft, 1);
    assert.equal(after.estimatedVnd, PRICE);
  });

  test("a draft from an older grader still counts as to grade", async () => {
    const h = harness();
    const jobId = await gradedJob(h);
    await saveAs(h, jobId, TEACHER, ["101"]);
    const draftDoc = h.db.collection("lmsDrafts").doc("7_477_101");
    const rec = (await draftDoc.get()).data();
    delete rec.graderVersion;
    await draftDoc.set(rec);
    const { counts } = await h.jobs.preview(TEACHER.id, 7, 477, PRICE);
    assert.equal(counts.candidate, 2);
    assert.equal(counts.toolDraft, 0);
  });
});
