const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { JobError, RetryLater } = require("../lib/gradingJobs.js");
const {
  DEFAULTS,
  WEEK,
  createGradingSchedules,
  firstReachable,
  nextLessonId,
  occurrence,
  offPeakSegments,
  parseOffPeak,
  pickRunAt,
  vnParts,
} = require("../lib/gradingSchedules.js");
const {
  LESSON,
  createHarness,
  makeTab,
} = require("./helpers/gradingHarness.js");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CLASS_TYPE = "basic_since_01042026";

/** Tuesday 29/09/2026 20:00 in Vietnam, and Wednesday 12:00 the day after. */
const T0 = Date.UTC(2026, 8, 29, 13, 0);
const G0 = Date.UTC(2026, 8, 30, 5, 0);
const KEY = "2026-09-29";
const TEACHER = { email: "teacher@x.com", authKind: "google", isAdmin: false };

const WINDOWS = parseOffPeak(DEFAULTS.offPeakUtc);
const OPTS = { ...DEFAULTS, windows: WINDOWS };

const pending = (answers = ["I done it", "ok answer"]) => makeTab({ answers });
const noTab = () => makeTab({ answers: ["x"], title: "BUỔI 99" });
const graded = () => makeTab({ answers: ["x"], feedback: ["Cô đã chữa"] });

/**
 * A grading-job harness with a schedule service on top, sharing its clock,
 * Firestore and queue. `c2Docs` moves those students to a second class of the
 * same teacher (same payer).
 */
function scheduleHarness({
  tabs,
  points = 100,
  c2Docs = [],
  startAt = T0 - DAY,
} = {}) {
  const h = createHarness({ tabs, points, startAt });
  const seed = (path, data) =>
    h.db._apply({ type: "set", path, data, options: { merge: true } });
  seed("lesson/lesson10", { name: LESSON, classType: [CLASS_TYPE] });
  seed("lesson/lesson11", { name: "BUỔI 11", classType: [CLASS_TYPE] });
  seed("classes/c1", { currentLesson: "lesson10", isActive: true });
  if (c2Docs.length) {
    seed("classes/c2", {
      name: "Lớp B",
      classType: CLASS_TYPE,
      teacherId: ["t1"],
      currentLesson: "lesson10",
      isActive: true,
    });
    Object.keys(tabs).forEach((docId, i) => {
      if (c2Docs.includes(docId)) seed(`students/s${i}`, { classId: "c2" });
    });
  }

  const notifications = [];
  const pushes = [];
  const audits = [];
  const faults = { notify: 0 };
  const createJobHooks = { before: null, after: null };
  const once = (key, arg) => {
    const fn = createJobHooks[key];
    createJobHooks[key] = null;
    return fn ? fn(arg) : undefined;
  };

  const s = createGradingSchedules({
    db: h.db,
    gradingJobs: {
      countSubmissions: (args) => h.jobs.countSubmissions(args),
      async createJob(args) {
        await once("before", args);
        const result = await h.jobs.createJob(args);
        await once("after", result);
        return result;
      },
    },
    enqueue: (name, payload) => h.queue.enqueue(name, payload),
    resolvePayer: async (email) =>
      email === "teacher@x.com" || email === "admin@x.com"
        ? { id: "t1", gmail: "teacher@x.com", name: "Cô Hà" }
        : null,
    resolveTeacher: async (email) =>
      email === "teacher@x.com"
        ? { id: "t1" }
        : email === "other@x.com"
          ? { id: "t9" }
          : null,
    hasRefreshToken: async () => !h.hooks.noStoredToken,
    async notify(n) {
      if (faults.notify > 0) {
        faults.notify -= 1;
        throw new Error("bell write lost");
      }
      notifications.push(n);
    },
    push: async (n) => pushes.push(n),
    audit: async (a) => audits.push(a),
    now: h.now,
  });
  h.hooks.schedules = () => s;

  const handler = (p) =>
    p.kind === "schedule" ? s.handleTask(p) : h.jobs.handleTask(p);
  const drainAll = () => h.queue.drain(handler);
  return {
    ...h,
    s,
    notifications,
    pushes,
    audits,
    faults,
    createJobHooks,
    drainAll,
    /** Moves the clock to `ms`, ticks, and runs everything that got queued. */
    async at(ms) {
      h.setClock(ms);
      await s.tick();
      await drainAll();
    },
    /** Runs queued tasks until the next one matches `stop`. */
    async stepUntil(stop) {
      while (h.queue.pending.length && !stop(h.queue.pending[0].payload)) {
        const task = h.queue.pending.shift();
        try {
          await handler(task.payload);
        } catch {
          h.queue.pending.push(task);
        }
      }
    },
    save: (
      classId = "c1",
      studentDeadlineAt = T0,
      graderDeadlineAt = G0,
      viewer = TEACHER,
    ) => s.upsert({ viewer, classId, studentDeadlineAt, graderDeadlineAt }),
    schedule: (classId = "c1") => h.db.dump("gradingSchedules")[classId],
    runDoc: (classId = "c1", key = KEY) =>
      h.db.dump(`gradingSchedules/${classId}/runs`)[key],
    reservations: () => h.db.dump("pointReservations").t1?.entries || {},
    lessonOf: (classId = "c1") => h.db.dump("classes")[classId].currentLesson,
    jobCount: () => Object.keys(h.db.dump("gradingJobs")).length,
    types: () => notifications.map((n) => n.type),
  };
}

/** Saves the default schedule and runs up to (and including) the reminder. */
async function reminded(h, classId = "c1") {
  await h.save(classId);
  await h.at(h.schedule(classId).nextDueAt);
}

// ---------------------------------------------------------------------------
// pure time math
// ---------------------------------------------------------------------------

describe("time: when to grade", () => {
  const D = Date.UTC(2026, 8, 29);
  const seg = { start: D + 16.5 * HOUR, end: D + DAY + 0.5 * HOUR }; // 23:30–07:30 VN
  const j20 = 19 * MIN + 59 * 1000;
  const pick = (ws, we, jitter) =>
    pickRunAt({ ws, we, jitter, windows: WINDOWS });

  it("the default off-peak window is 23:30–07:30 Vietnam time, across midnight UTC", () => {
    const segments = offPeakSegments(
      D + 20 * HOUR,
      D + DAY + 0.2 * HOUR,
      WINDOWS,
    );
    assert.ok(segments.some((x) => x.start === seg.start && x.end === seg.end));
    assert.equal(vnParts(seg.start).time, "23:30");
    assert.equal(vnParts(seg.end).time, "07:30");
  });

  it("overlap of only 5 minutes at the END of off-peak: jitter is clamped inside it", () => {
    const ws = seg.end - 5 * MIN; // 07:25 VN
    const { runAt, offPeak } = pick(ws, ws + 5 * HOUR, j20);
    assert.equal(offPeak, true);
    assert.equal(runAt, ws + 4 * MIN);
    assert.ok(runAt < seg.end);
  });

  it("a window starting exactly at 07:30 has no overlap (half-open end)", () => {
    const { runAt, offPeak } = pick(seg.end, seg.end + 5 * HOUR, 7 * MIN);
    assert.equal(offPeak, false);
    assert.equal(runAt, seg.end + 7 * MIN);
  });

  it("a window starting exactly at 23:30 grades at 23:30 + jitter", () => {
    const { runAt, offPeak } = pick(seg.start, seg.start + 5 * HOUR, 7 * MIN);
    assert.equal(offPeak, true);
    assert.equal(runAt, seg.start + 7 * MIN);
  });

  it("a window entirely inside off-peak starts it + jitter", () => {
    const ws = D + 17 * HOUR;
    assert.equal(pick(ws, D + 20 * HOUR, 5 * MIN).runAt, ws + 5 * MIN);
  });

  it("an overlap straddling midnight UTC", () => {
    const ws = D + 23 * HOUR + 50 * MIN;
    const { runAt, offPeak } = pick(ws, D + DAY + 20 * MIN, j20);
    assert.equal(offPeak, true);
    assert.equal(runAt, ws + j20);
  });

  it("jitter 19′59″ against overlaps of 20′ and 19′: clamped to overlap − 1′", () => {
    const a20 = seg.end - 20 * MIN;
    assert.equal(pick(a20, seg.end + HOUR, j20).runAt, a20 + 19 * MIN);
    const a19 = seg.end - 19 * MIN;
    assert.equal(pick(a19, seg.end + HOUR, j20).runAt, a19 + 18 * MIN);
    // A shorter jitter is used as is.
    assert.equal(pick(a20, seg.end + HOUR, 5 * MIN).runAt, a20 + 5 * MIN);
  });

  it("overlaps of 30″ and 1′ grade at their start, never before it", () => {
    const a30 = seg.end - 30 * 1000;
    assert.equal(pick(a30, seg.end + HOUR, j20).runAt, a30);
    const a60 = seg.end - MIN;
    assert.equal(pick(a60, seg.end + HOUR, j20).runAt, a60);
  });

  it("a zero-length window grades at its start", () => {
    const ws = D + 3 * HOUR;
    assert.deepEqual(pick(ws, ws, j20), { runAt: ws, offPeak: false });
  });

  it("a window that never touches off-peak stays inside the window", () => {
    const ws = D + HOUR;
    const we = D + 10 * HOUR;
    const { runAt, offPeak } = pick(ws, we, j20);
    assert.equal(offPeak, false);
    assert.equal(runAt, ws + j20);
    assert.equal(pick(ws, ws + MIN, j20).runAt, ws + MIN);
  });

  it("random windows: runAt always inside the window, and inside off-peak when it says so", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 3000; i++) {
      const ws = D + Math.floor(rand() * 3 * DAY);
      const we = ws + Math.floor(rand() * 2 * DAY);
      const jitter = Math.floor(rand() * 20 * MIN);
      const { runAt, offPeak } = pick(ws, we, jitter);
      assert.ok(runAt >= ws && runAt <= we, `outside window at ${i}`);
      if (offPeak) {
        const inside = offPeakSegments(ws, we, WINDOWS).some(
          (x) => runAt >= x.start && runAt < x.end,
        );
        assert.ok(inside, `claimed off-peak but is not, at ${i}`);
      }
    }
  });

  it("time invariant holds for random schedules: deadline + grace ≤ remind < run ≤ grader − margin", () => {
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 1000; i++) {
      const def = {
        classId: `c${i}`,
        anchorStudentAt: T0 + Math.floor(rand() * 60 * DAY),
        gapMs: 2 * HOUR + Math.floor(rand() * (WEEK - 2 * HOUR)),
      };
      const occ = occurrence(def, i % 5, OPTS);
      const remindAt = occ.runAt - OPTS.remindMs;
      assert.ok(occ.studentDeadlineAt + OPTS.graceMs <= remindAt);
      assert.ok(remindAt < occ.runAt);
      assert.ok(occ.runAt <= occ.graderDeadlineAt - OPTS.runMarginMs);
    }
  });

  it("the default schedule grades Tuesday night, off-peak", () => {
    assert.equal(vnParts(T0).weekday, 2);
    const occ = occurrence(
      { classId: "c1", anchorStudentAt: T0, gapMs: G0 - T0 },
      0,
      OPTS,
    );
    assert.equal(occ.runKey, KEY);
    assert.equal(occ.offPeak, true);
    assert.ok(
      occ.runAt >= T0 + 3.5 * HOUR && occ.runAt < T0 + 3.5 * HOUR + 20 * MIN,
    );
  });

  it("a week boundary: Sunday 22:00 → Monday 10:00, one week later", () => {
    const sunday = Date.UTC(2026, 9, 4, 15, 0); // Sun 04/10 22:00 VN
    const def = { classId: "c1", anchorStudentAt: sunday, gapMs: 12 * HOUR };
    const occ = occurrence(def, 1, OPTS);
    assert.equal(occ.runKey, "2026-10-11");
    assert.equal(vnParts(occ.graderDeadlineAt).weekday, 1);
    assert.equal(occ.studentDeadlineAt, sunday + WEEK);
  });

  it("first reachable week skips the ones already too late", () => {
    const def = { classId: "c1", anchorStudentAt: T0, gapMs: G0 - T0 };
    assert.equal(firstReachable(def, 0, T0 - DAY, OPTS).index, 0);
    assert.equal(firstReachable(def, 0, G0, OPTS).index, 1);
    assert.equal(firstReachable(def, 0, T0 + 10 * WEEK, OPTS).index, 10);
  });
});

describe("next lesson", () => {
  const L = (...ids) => ids.map((id) => ({ id, name: id.toUpperCase() }));
  it("the next number up, in the lessonNN ids", () => {
    assert.deepEqual(
      nextLessonId("lesson10", L("lesson09", "lesson11", "lesson12")),
      {
        id: "lesson11",
        name: "LESSON11",
      },
    );
    assert.equal(
      nextLessonId("lesson10", L("lesson12", "lesson13")).id,
      "lesson12",
    );
  });
  it("no next lesson: last_lesson", () => {
    assert.deepEqual(nextLessonId("lesson23", L("lesson22", "lesson23")), {
      reason: "last_lesson",
    });
  });
  it("an id without a number, or two lessons with the next number: unknown_order", () => {
    assert.equal(nextLessonId("abc", L("lesson11")).reason, "unknown_order");
    assert.equal(
      nextLessonId("lesson10", L("lesson11", "lesson011")).reason,
      "unknown_order",
    );
  });
});

// ---------------------------------------------------------------------------
// setting a schedule up
// ---------------------------------------------------------------------------

describe("saving a schedule", () => {
  it("plans the first week: reminder 30′ before an off-peak run", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    const saved = await h.save();
    const s = h.schedule();
    assert.equal(s.enabled, true);
    assert.equal(s.nextStep, "remind");
    assert.equal(s.next.runKey, KEY);
    assert.equal(s.nextDueAt, s.next.runAt - 30 * MIN);
    assert.deepEqual(s.studentDeadline, { weekday: 2, time: "20:00" });
    assert.deepEqual(s.graderDeadline, { weekday: 3, time: "12:00" });
    assert.equal(saved.next.remindAt, s.nextDueAt);
  });

  it("preview has no side effects at all", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    const before = h.db.clock;
    const { next } = await h.s.preview({
      viewer: TEACHER,
      classId: "c1",
      studentDeadlineAt: T0,
      graderDeadlineAt: G0,
    });
    assert.equal(next.runKey, KEY);
    assert.equal(h.db.clock, before, "no Firestore write");
    assert.equal(
      h.notifications.length + h.audits.length + h.queue.pending.length,
      0,
    );
  });

  it("refuses deadlines closer than the minimum, a class without lesson, another teacher's class, and a missing Google grant", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await assert.rejects(
      h.save("c1", T0, T0 + 90 * MIN),
      (e) => e.code === "deadline_gap_too_short",
    );
    await assert.rejects(
      h.save("c1", T0, G0, { email: "other@x.com", authKind: "jwt" }),
      (e) => e.code === "not_your_class",
    );
    h.hooks.noStoredToken = true;
    await assert.rejects(h.save(), (e) => e.code === "google_reauth_required");
    h.hooks.noStoredToken = false;
    h.db._apply({
      type: "set",
      path: "classes/c1",
      data: { currentLesson: null },
      options: { merge: true },
    });
    await assert.rejects(h.save(), (e) => e.code === "no_current_lesson");
    assert.equal(h.schedule(), undefined);
  });
});

// ---------------------------------------------------------------------------
// the reminder
// ---------------------------------------------------------------------------

describe("reminder", () => {
  it("counts the submissions, reserves their points and announces the run", async () => {
    const h = scheduleHarness({
      tabs: { docA: pending(), docB: pending(), docX: noTab() },
    });
    await reminded(h);
    const run = h.runDoc();
    assert.equal(run.state, "reminded");
    assert.equal(run.submitted, 2);
    assert.equal(run.totalStudents, 3);
    assert.deepEqual(
      Object.values(h.reservations()).map((e) => e.points),
      [2],
    );
    assert.equal(h.schedule().nextStep, "run");
    assert.equal(h.schedule().nextDueAt, run.runAt);

    const [n] = h.notifications;
    assert.equal(n.type, "grading.autoUpcoming");
    assert.equal(n.data.minutes, 30);
    assert.equal(n.data.submitted, 2);
    assert.equal(n.data.lessonName, LESSON);
    assert.match(n.data.path, /^\/grade\?classId=c1&lessonId=lesson10$/);
    assert.deepEqual(n.recipients, ["teacher@x.com"]);
    assert.equal(h.pushes.length, 1);
    assert.equal(h.audits.length, 1);
  });

  it("delivered again (and concurrently): nothing changes, nothing is re-sent", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    const version = h.db.clock;
    await Promise.all([h.s.remind("c1", KEY), h.s.remind("c1", KEY)]);
    assert.equal(h.db.clock, version);
    assert.equal(h.notifications.length, 1);
    assert.equal(h.pushes.length, 1);
  });

  it("nobody did the homework: cancelled, said so, next week planned", async () => {
    const h = scheduleHarness({ tabs: { docA: noTab(), docB: noTab() } });
    await reminded(h);
    assert.equal(h.runDoc().state, "cancelled_no_submissions");
    assert.deepEqual(h.types(), ["grading.autoCancelledNoSubmissions"]);
    assert.match(h.notifications[0].body, /0\/2 học sinh làm bài/);
    assert.equal(h.schedule().next.runKey, "2026-10-06");
    assert.equal(h.schedule().nextStep, "remind");
    assert.deepEqual(h.reservations(), {});
  });

  it("everything already graded: cancelled, and the message says so", async () => {
    const h = scheduleHarness({ tabs: { docA: graded() } });
    await reminded(h);
    assert.equal(h.runDoc().state, "cancelled_no_submissions");
    assert.match(h.notifications[0].body, /đã được chấm từ trước/);
  });

  it("not enough points: cancelled with the numbers", async () => {
    const h = scheduleHarness({
      tabs: { docA: pending(), docB: pending() },
      points: 1,
    });
    await reminded(h);
    assert.equal(h.runDoc().state, "cancelled_no_points");
    const [n] = h.notifications;
    assert.equal(n.type, "grading.autoCancelledNoPoints");
    assert.equal(n.data.need, 2);
    assert.equal(n.data.available, 1);
    assert.equal(h.schedule().next.runKey, "2026-10-06");
  });

  it("two classes of one payer reminded at the same time: only one reservation fits", async () => {
    const h = scheduleHarness({
      tabs: {
        docA: pending(),
        docB: pending(),
        docC: pending(),
        docD: pending(),
      },
      c2Docs: ["docC", "docD"],
      points: 3,
    });
    await h.save("c1");
    await h.save("c2");
    h.setClock(
      Math.max(h.schedule("c1").nextDueAt, h.schedule("c2").nextDueAt),
    );
    await Promise.all([h.s.remind("c1", KEY), h.s.remind("c2", KEY)]);
    const states = [h.runDoc("c1").state, h.runDoc("c2").state].sort();
    assert.deepEqual(states, ["cancelled_no_points", "reminded"]);
    const reserved = Object.values(h.reservations()).reduce(
      (a, e) => a + e.points,
      0,
    );
    assert.equal(reserved, 2);
  });

  it("a late reminder moves the run back, keeping schedule, run and due time equal", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await h.save();
    const planned = h.schedule().next.runAt;
    await h.at(planned - 5 * MIN);
    const run = h.runDoc();
    assert.equal(run.state, "reminded");
    assert.equal(run.runAt, planned + 25 * MIN);
    assert.equal(h.schedule().next.runAt, run.runAt);
    assert.equal(h.schedule().nextDueAt, run.runAt);
  });

  it("normal tick lag keeps the planned (off-peak) time", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await h.save();
    const planned = h.schedule().next.runAt;
    await h.at(h.schedule().nextDueAt + 4 * MIN);
    assert.equal(h.runDoc().runAt, planned);
    assert.equal(h.notifications[0].data.minutes, 26);
  });

  it("too late to fit before the teacher's deadline: missed", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await h.save();
    await h.at(G0 - 80 * MIN);
    assert.equal(h.runDoc().state, "missed");
    assert.deepEqual(h.types(), ["grading.autoMissed"]);
    assert.equal(h.schedule().next.runKey, "2026-10-06");
  });

  it("a run step arriving before its time is sent back", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    await assert.rejects(h.s.run("c1", KEY), (e) => e instanceof RetryLater);
    assert.equal(h.runDoc().state, "reminded");
  });

  it("an expired reservation no longer holds points", async () => {
    const h = scheduleHarness({
      tabs: { docA: pending(), docB: pending() },
      points: 3,
    });
    h.db._apply({
      type: "set",
      path: "gradingSchedules/cX/runs/2026-01-01",
      data: { state: "reminded", classId: "cX", runKey: "2026-01-01" },
    });
    h.db._apply({
      type: "set",
      path: "pointReservations/t1",
      data: {
        entries: {
          "cX|2026-01-01": { points: 50, jobId: null, expiresAt: T0 - DAY - 1 },
        },
      },
    });
    await reminded(h);
    assert.equal(h.runDoc().state, "reminded");
    assert.deepEqual(Object.keys(h.reservations()), [`c1|${KEY}`]);
  });
});

// ---------------------------------------------------------------------------
// the whole week, end to end
// ---------------------------------------------------------------------------

describe("a scheduled week, end to end", () => {
  it("reminds, grades, charges, moves the class on and announces it — once", async () => {
    const h = scheduleHarness({
      tabs: { docA: pending(), docB: pending() },
      points: 10,
    });
    await reminded(h);
    await h.at(h.schedule().nextDueAt);

    const run = h.runDoc();
    assert.equal(run.state, "done");
    assert.equal(run.result.written, 2);
    assert.equal(h.points(), 8);
    assert.equal(h.lessonOf(), "lesson11");
    assert.deepEqual(run.lessonAdvance, {
      advanced: true,
      lessonId: "lesson11",
      lessonName: "BUỔI 11",
    });
    assert.deepEqual(h.reservations(), {});
    assert.deepEqual(h.types(), ["grading.autoUpcoming", "grading.autoDone"]);
    assert.match(
      h.notifications[1].body,
      /2 học sinh làm bài, đã ghi 2\/2 bài, trừ 2 point/,
    );
    assert.match(h.notifications[1].body, /chuyển sang BUỔI 11/);
    assert.equal(h.pushes.length, 2);
    assert.equal(h.schedule().next.runKey, "2026-10-06");
    assert.equal(h.schedule().nextStep, "remind");

    // The regular job notification never fired for the scheduled job...
    assert.equal(h.counters.notify, 0);
    assert.equal(h.counters.push, 0);
    assert.equal(h.counters.summary, 1, "the audit summary still does");
    // ...but still does for a job started by hand.
    await h.start({ lessonId: "lesson10" });
    await h.drainAll();
    assert.equal(h.counters.notify, 1);
  });

  it("the teacher moved the lesson while the job ran: left alone", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.hooks.afterConsume = async () => {
      h.hooks.afterConsume = null;
      h.db._apply({
        type: "set",
        path: "classes/c1",
        data: { currentLesson: "lesson15" },
        options: { merge: true },
      });
    };
    await h.at(h.schedule().nextDueAt);
    assert.equal(h.runDoc().state, "done");
    assert.equal(h.lessonOf(), "lesson15");
    assert.deepEqual(h.runDoc().lessonAdvance, {
      advanced: false,
      reason: "changed",
    });
  });
});

// ---------------------------------------------------------------------------
// points: invariant (P) and its exceptions
// ---------------------------------------------------------------------------

describe("points reserved across classes", () => {
  it("a reminder landing between a charge and its count under-states what is free, never over-grants", async () => {
    const h = scheduleHarness({
      tabs: {
        docA: pending(),
        docB: pending(),
        docC: pending(),
        docD: pending(),
      },
      c2Docs: ["docC", "docD"],
      points: 4,
    });
    await h.save("c1");
    await h.save("c2");
    h.setClock(h.schedule("c1").nextDueAt);
    await h.s.remind("c1", KEY);
    assert.equal(h.runDoc("c1").state, "reminded");
    assert.equal(h.runDoc("c2"), undefined);

    h.hooks.afterConsume = async () => {
      h.hooks.afterConsume = null;
      // TeacherPoint already debited, job.charged not yet counted.
      assert.equal(h.points(), 3);
      await h.s.remind("c2", KEY);
    };
    h.setClock(h.runDoc("c1").runAt);
    await h.s.run("c1", KEY);
    await h.drainAll();

    const b = h.runDoc("c2");
    assert.equal(b.state, "cancelled_no_points");
    assert.equal(b.available, 1, "3 points minus A's still-uncounted 2");
    assert.equal(h.points(), 2);
  });

  it("a job that spent more than it reserved (late hand-ins) is clamped at 0, not credited", async () => {
    const h = scheduleHarness({
      tabs: {
        docA: pending(),
        docLate: noTab(),
        docC: pending(),
        docD: pending(),
        docE: pending(),
      },
      c2Docs: ["docC", "docD", "docE"],
      points: 4,
    });
    await h.save("c1");
    await h.at(h.schedule("c1").nextDueAt);
    assert.equal(h.runDoc("c1").pointsNeeded, 1);
    // A student hands in after the reminder.
    h.docsApi.edit("docLate", (tab) => {
      tab.tabProperties.title = LESSON;
    });
    h.setClock(h.runDoc("c1").runAt);
    await h.s.run("c1", KEY);
    await h.stepUntil((p) => p.step === "finalize");
    assert.equal(h.job(h.runDoc("c1").jobId).charged, 2);
    assert.equal(h.points(), 2);

    await h.save("c2");
    await h.s.remind("c2", KEY);
    const b = h.runDoc("c2");
    assert.equal(b.state, "cancelled_no_points");
    assert.equal(b.reserved, 0, "max(0, 1 − 2), not −1");
    assert.equal(b.available, 2);
  });

  it("E1: the overspend eats another class's reservation — that job stops, the balance never goes negative", async () => {
    const h = scheduleHarness({
      tabs: {
        docA: pending(),
        docLate: noTab(),
        docC: pending(),
        docD: pending(),
      },
      c2Docs: ["docC", "docD"],
      points: 3,
    });
    await h.save("c1");
    await h.save("c2");
    const late = Math.max(
      h.schedule("c1").nextDueAt,
      h.schedule("c2").nextDueAt,
    );
    h.setClock(late);
    await h.s.remind("c1", KEY);
    await h.s.remind("c2", KEY);
    assert.equal(h.runDoc("c1").state, "reminded");
    assert.equal(h.runDoc("c2").state, "reminded");
    h.docsApi.edit("docLate", (tab) => {
      tab.tabProperties.title = LESSON;
    });
    h.setClock(Math.max(h.runDoc("c1").runAt, h.runDoc("c2").runAt));
    await h.s.run("c1", KEY);
    await h.drainAll();
    assert.equal(h.points(), 1);
    await h.s.run("c2", KEY);
    await h.drainAll();
    assert.equal(h.runDoc("c2").state, "failed");
    assert.equal(h.runDoc("c2").result.error, "not_enough_points");
    assert.equal(h.points(), 1);
    assert.ok(h.types().includes("grading.autoFailed"));
    assert.deepEqual(h.reservations(), {});
  });
});

// ---------------------------------------------------------------------------
// the run step: crash windows and races
// ---------------------------------------------------------------------------

describe("run step", () => {
  it("dies after claiming the run: the next tick starts exactly one job", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.createJobHooks.before = () => {
      throw new Error("instance stopped");
    };
    h.setClock(h.schedule().nextDueAt);
    await assert.rejects(h.s.run("c1", KEY));
    assert.equal(h.runDoc().state, "starting");
    assert.equal(h.schedule().nextStep, "run", "schedule not advanced (I1)");
    assert.equal(h.jobCount(), 0);

    await h.at(h.now() + 5 * MIN);
    assert.equal(h.jobCount(), 1);
    assert.equal(h.runDoc().state, "done");
    assert.equal(h.schedule().next.index, 1);
  });

  it("dies after creating the job, its prepare task lost: the retry finds the job and re-queues it", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.createJobHooks.after = () => {
      throw new Error("instance stopped");
    };
    h.setClock(h.schedule().nextDueAt);
    await assert.rejects(h.s.run("c1", KEY));
    assert.equal(h.jobCount(), 1);
    assert.equal(h.runDoc().state, "starting");
    // The prepare task never made it.
    const lost = h.queue.pending.findIndex((t) => t.payload.step === "prepare");
    h.queue.names.delete(h.queue.pending[lost].name);
    h.queue.pending.splice(lost, 1);

    await h.at(h.now() + 5 * MIN);
    assert.equal(h.jobCount(), 1, "no second job");
    assert.equal(h.runDoc().state, "done");
    assert.equal(h.schedule().next.index, 1, "advanced exactly once");
    assert.deepEqual(h.types(), ["grading.autoUpcoming", "grading.autoDone"]);
  });

  it("switched off between the claim and the job's creation: the guard refuses it", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.createJobHooks.before = () =>
      h.s.disable({ viewer: TEACHER, classId: "c1" });
    h.setClock(h.schedule().nextDueAt);
    await h.s.run("c1", KEY);
    assert.equal(h.jobCount(), 0);
    assert.equal(h.runDoc().state, "cancelled_other");
    assert.equal(h.runDoc().reason, "schedule_disabled");
    assert.equal(h.schedule().enabled, false);
    assert.equal(h.schedule().nextDueAt, null);
    assert.deepEqual(h.reservations(), {});
  });

  it("switched off after the job exists: the job finishes, the week is closed, nothing more is due", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.createJobHooks.after = () => {
      throw new Error("instance stopped");
    };
    h.setClock(h.schedule().nextDueAt);
    await assert.rejects(h.s.run("c1", KEY));
    await h.s.disable({ viewer: TEACHER, classId: "c1" });
    assert.equal(h.schedule().nextStep, "run", "kept so Tx B can finish");

    await h.at(h.now() + 5 * MIN);
    assert.equal(h.runDoc().state, "done");
    assert.equal(h.schedule().enabled, false);
    assert.equal(h.schedule().nextDueAt, null);
    assert.equal(h.jobCount(), 1);
  });

  it("stuck in starting past the teacher's deadline: missed, no job", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.createJobHooks.before = () => {
      throw new Error("instance stopped");
    };
    h.setClock(h.schedule().nextDueAt);
    await assert.rejects(h.s.run("c1", KEY));
    h.setClock(G0 + 1);
    await h.s.run("c1", KEY);
    assert.equal(h.runDoc().state, "missed");
    assert.equal(h.jobCount(), 0);
    assert.equal(h.schedule().next.runKey, "2026-10-06");
    assert.deepEqual(h.types(), ["grading.autoUpcoming", "grading.autoMissed"]);
    assert.deepEqual(h.reservations(), {});
  });

  it("the teacher is grading the lesson by hand: this week is cancelled", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    await h.start({ lessonId: "lesson10" }); // not drained: still running
    h.setClock(h.schedule().nextDueAt);
    await h.s.run("c1", KEY);
    assert.equal(h.runDoc().state, "cancelled_other");
    assert.equal(h.runDoc().reason, "job_in_progress");
    assert.equal(h.types()[1], "grading.autoCancelledOther");
    assert.deepEqual(h.reservations(), {});
    assert.equal(h.schedule().next.runKey, "2026-10-06");
  });

  it("editing the times after the reminder re-plans the same week and frees its points", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    await h.save("c1", T0 + 30 * MIN, G0);
    assert.equal(h.runDoc(), undefined);
    assert.deepEqual(h.reservations(), {});
    assert.equal(h.schedule().next.runKey, KEY);
    assert.equal(h.schedule().nextStep, "remind");
  });
});

// ---------------------------------------------------------------------------
// onJobFinished: the one owner of a scheduled job's end
// ---------------------------------------------------------------------------

describe("the end of a scheduled job", () => {
  it("the bell write fails after the commit: the retry sends it once and moves the lesson once", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    await reminded(h);
    h.faults.notify = 1;
    await h.at(h.schedule().nextDueAt);
    assert.equal(h.runDoc().state, "done");
    assert.equal(h.lessonOf(), "lesson11", "not lesson12");
    assert.deepEqual(h.types(), ["grading.autoUpcoming", "grading.autoDone"]);
    assert.equal(
      h.pushes.filter((p) => p.type === "grading.autoDone").length,
      1,
    );
  });

  it("a run left finished and released but without its lesson decision gets it — once", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    h.db._apply({
      type: "set",
      path: `gradingSchedules/c1/runs/${KEY}`,
      data: {
        classId: "c1",
        runKey: KEY,
        state: "done",
        doneEvent: "done",
        payerTeacherId: "t1",
        recipients: ["teacher@x.com"],
        lessonName: LESSON,
        runAt: T0 + 4 * HOUR,
        result: { written: 1, total: 1, charged: 1 },
      },
    });
    const job = {
      origin: { type: "schedule", classId: "c1", runKey: KEY },
      status: "done",
      written: 1,
      total: 1,
      lessonId: "lesson10",
    };
    await h.s.onJobFinished(job);
    await h.s.onJobFinished(job);
    assert.equal(h.lessonOf(), "lesson11");
    assert.equal(h.runDoc().lessonAdvance.advanced, true);
    assert.equal(h.types().filter((t) => t === "grading.autoDone").length, 1);
  });

  it("the last lesson stays put and says so", async () => {
    const h = scheduleHarness({ tabs: { docA: pending() } });
    h.db._apply({ type: "delete", path: "lesson/lesson11" });
    await reminded(h);
    await h.at(h.schedule().nextDueAt);
    assert.equal(h.lessonOf(), "lesson10");
    assert.equal(h.runDoc().lessonAdvance.reason, "last_lesson");
    assert.match(h.notifications[1].body, /buổi cuối/);
  });
});

// ---------------------------------------------------------------------------
// createJob with a caller-chosen id
// ---------------------------------------------------------------------------

describe("createJob with a fixed id", () => {
  const args = {
    email: "teacher@x.com",
    authKind: "google",
    isAdmin: false,
    classId: "c1",
    lessonId: "l10",
  };

  it("a second call returns the job the first one created", async () => {
    const h = createHarness({ tabs: { docA: pending() } });
    const first = await h.jobs.createJob({ ...args, jobId: "s_fixed" });
    const second = await h.jobs.createJob({ ...args, jobId: "s_fixed" });
    assert.equal(first.jobId, "s_fixed");
    assert.deepEqual(second, { jobId: "s_fixed", existing: true });
    assert.equal(Object.keys(h.db.dump("gradingJobs")).length, 1);
  });

  it("a guard that says no creates nothing and takes no lock", async () => {
    const h = createHarness({ tabs: { docA: pending() } });
    await assert.rejects(
      h.jobs.createJob({ ...args, jobId: "s_fixed", guard: async () => false }),
      (e) => e instanceof JobError && e.code === "guard_rejected",
    );
    assert.deepEqual(h.db.dump("gradingJobs"), {});
    assert.deepEqual(h.db.dump("gradingJobLocks"), {});
  });
});
