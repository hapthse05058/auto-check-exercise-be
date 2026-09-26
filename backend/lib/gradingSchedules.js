/**
 * Scheduled grading: every class may have one weekly schedule — the students'
 * hand-in deadline and the teacher's grading deadline — and the backend grades
 * the class's current lesson somewhere between the two, preferably during
 * DeepSeek's off-peak hours. The teacher hears about it twice: ~30 minutes
 * before ("N students did the homework, grading at HH:mm") and once it is done.
 * A week nobody handed anything in, or one the points cannot cover, is
 * cancelled at the reminder instead, with a notification saying why.
 *
 * HOW IT RUNS. Cloud Scheduler calls tick() every 5 minutes. tick() only looks
 * for schedules whose `nextDueAt` has passed and enqueues their step (remind or
 * run) as a Cloud Task on the grading queue. Delivery is AT LEAST ONCE, and the
 * task name carries a 5-minute bucket ON PURPOSE, so the same step may run
 * several times, even concurrently. Correctness rests on three invariants, not
 * on task names:
 *
 *  (I1) The schedule (`next`, `nextStep`, `nextDueAt`) only changes inside the
 *       transaction that records a step's outcome on the run doc. Until a step
 *       commits, `nextDueAt` stays in the past and the next tick re-delivers
 *       it — nothing can be left "advanced but not done".
 *  (I2) `gradingSchedules/{classId}/runs/{runKey}.state` is the truth for one
 *       week. Each step re-checks it inside its transaction; a step that finds
 *       the state already past it changes nothing but the missing side effects.
 *  (I3) Bell entries and pushes go out AFTER the commit, each behind a flag on
 *       the run doc (the pattern of gradingJobs.finalize): the bell has a fixed
 *       id, so a retry overwrites it; the push is claimed before it is sent, so
 *       it goes out at most once.
 *
 * POINTS. At the reminder the week's need (the students who did the homework)
 * is reserved in `pointReservations/{payerTeacherId}` — one document per payer,
 * read and written by every reminder of that payer's classes, which makes it
 * the point where they serialise. Invariant (P): at the moment a reminder
 * commits, point ≥ Σ max(0, reserved_i − charged_i) over the live
 * reservations, the new one included. The transaction reads TeacherPoint, the
 * reservation doc and every reserved job, so a concurrent charge (which
 * decrements TeacherPoint first and bumps job.charged after) forces a retry;
 * the only state it can observe in between is "debited, not yet counted",
 * which UNDER-states what is free. It does NOT hold at every later moment:
 *  (E1) students who hand in after the reminder are graded too, so a job can
 *       spend more than it reserved, eating into another class's reservation;
 *  (E2) grading by hand does not reserve.
 * In both cases the balance still cannot go negative (consumePointsForDocs
 * checks it in its own transaction) and the other job stops through the
 * existing guards (prepare `not_enough_points`, write `stopped`).
 *
 * THE END OF A SCHEDULED JOB is owned by onJobFinished() alone — run state,
 * releasing the reservation, the "done" notification and moving the class on
 * to its next lesson. server.js only delegates to it.
 *
 * Times are epoch milliseconds. Vietnam is UTC+7 all year (no DST), so a week
 * later is always exactly +7 days and the schedule needs no timezone library.
 */
const crypto = require("crypto");

const { createCourses } = require("./courses.js");
const { ReauthRequiredError } = require("./googleUserToken.js");
const {
  JOB_STALE_MS,
  JOB_TERMINAL,
  JobError,
  RetryLater,
} = require("./gradingJobs.js");

const SCHEDULES = "gradingSchedules";
const RESERVATIONS = "pointReservations";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const VN_OFFSET_MS = 7 * HOUR;

/** How often Cloud Scheduler calls tick() — also the task-name bucket. */
const TICK_MS = 5 * MINUTE;

const DEFAULTS = {
  /** Students' docs keep syncing for a moment after the deadline. */
  graceMs: 10 * MINUTE,
  /** How long before grading the teacher is told. */
  remindMs: 30 * MINUTE,
  /** Grading must start this long before the teacher's deadline. */
  runMarginMs: 60 * MINUTE,
  /** Shortest allowed gap between the two deadlines (UI says 2 hours). */
  minGapMs: 2 * HOUR,
  maxGapMs: WEEK,
  /** Classes are spread over this much of the off-peak window. */
  jitterMs: 20 * MINUTE,
  /**
   * A reminder this late (tick lag, an outage) pushes grading back so the
   * teacher still gets roughly the promised notice. Normal tick lag (≤ 5 min)
   * stays under it, so the planned — off-peak — time is kept.
   */
  lateToleranceMs: 10 * MINUTE,
  /** DeepSeek off-peak, UTC. 16:30–00:30 UTC = 23:30–07:30 in Vietnam. */
  offPeakUtc: "16:30-00:30",
};

const RUN_ACTIVE = new Set(["reminded", "starting", "running"]);

/** createJob refusals that retrying cannot fix: the week is cancelled. */
const PERMANENT_START_ERRORS = new Set([
  "job_in_progress",
  "google_reauth_required",
  "no_docs",
  "class_not_found",
  "lesson_not_found",
  "too_many_docs",
  "payer_not_found",
  "invalid_doc_ids",
  "classId_and_lessonId_required",
]);

// eslint-disable-next-line no-console
const info = (...args) => console.log("[GRADING-SCHEDULE]", ...args);

// ---------------------------------------------------------------------------
// Pure time math
// ---------------------------------------------------------------------------

/** "16:30-00:30,03:00-04:00" (UTC) → [{start, end}] in minutes of the day. */
function parseOffPeak(spec) {
  const toMinutes = (hhmm) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (!match) throw new Error(`bad off-peak time "${hhmm}"`);
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    if (Number(match[1]) > 24 || Number(match[2]) > 59 || minutes > 1440) {
      throw new Error(`bad off-peak time "${hhmm}"`);
    }
    return minutes;
  };
  return String(spec || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [start, end] = part.split("-");
      return { start: toMinutes(start), end: toMinutes(end) };
    })
    .filter(({ start, end }) => start !== end);
}

/**
 * The off-peak windows as absolute half-open segments [start, end) covering
 * [fromMs, toMs], sorted. A window whose end is before its start wraps past
 * midnight UTC (the default one does).
 */
function offPeakSegments(fromMs, toMs, windows) {
  const segments = [];
  const firstDay = Math.floor(fromMs / DAY) - 1;
  const lastDay = Math.floor(toMs / DAY) + 1;
  for (let day = firstDay; day <= lastDay; day++) {
    for (const { start, end } of windows) {
      const s = day * DAY + start * MINUTE;
      const e = day * DAY + end * MINUTE + (end <= start ? DAY : 0);
      if (e > fromMs && s <= toMs) segments.push({ start: s, end: e });
    }
  }
  return segments.sort((a, b) => a.start - b.start);
}

/** Stable per-class offset in [0, jitterMs), whole seconds. */
function jitterFor(classId, jitterMs = DEFAULTS.jitterMs) {
  const seconds = Math.max(1, Math.floor(jitterMs / 1000));
  const hash = crypto.createHash("sha1").update(String(classId)).digest();
  return (hash.readUInt32BE(0) % seconds) * 1000;
}

/**
 * When to grade inside the window [ws, we]: the start of the first off-peak
 * stretch that overlaps it, pushed back by the class's jitter — clamped so it
 * never leaves the overlap (nor goes before its start when the overlap is
 * shorter than a minute). No overlap: the start of the window, jittered.
 */
function pickRunAt({ ws, we, jitter, windows }) {
  for (const seg of offPeakSegments(ws, we, windows)) {
    const a = Math.max(ws, seg.start);
    const b = Math.min(we, seg.end);
    if (b - a > 0) {
      return {
        runAt: a + Math.min(jitter, Math.max(0, b - a - MINUTE)),
        offPeak: true,
      };
    }
  }
  return { runAt: ws + Math.min(jitter, Math.max(0, we - ws)), offPeak: false };
}

/** Wall-clock parts in Vietnam. */
function vnParts(ms) {
  const d = new Date(ms + VN_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return {
    weekday: d.getUTCDay(), // 0 = Sunday
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    display: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`,
  };
}

/**
 * Occurrence `index` of a schedule: the week's two deadlines, its run key and
 * when grading happens. Asserts the time invariant
 *   studentDeadline + grace ≤ runAt − remind < runAt ≤ graderDeadline − margin
 * which the minimum gap guarantees.
 */
function occurrence(schedule, index, opts) {
  const studentDeadlineAt = schedule.anchorStudentAt + index * WEEK;
  const graderDeadlineAt = studentDeadlineAt + schedule.gapMs;
  const ws = studentDeadlineAt + opts.graceMs + opts.remindMs;
  const we = graderDeadlineAt - opts.runMarginMs;
  if (we < ws) throw new Error("schedule window is too short");
  const { runAt, offPeak } = pickRunAt({
    ws,
    we,
    jitter: jitterFor(schedule.classId, opts.jitterMs),
    windows: opts.windows,
  });
  if (
    !(studentDeadlineAt + opts.graceMs <= runAt - opts.remindMs) ||
    !(runAt <= we)
  ) {
    throw new Error("schedule time invariant violated");
  }
  return {
    index,
    runKey: vnParts(studentDeadlineAt).date,
    studentDeadlineAt,
    graderDeadlineAt,
    runAt,
    offPeak,
  };
}

/** Can this occurrence still be graded if its reminder went out at `nowMs`? */
function reachable(occ, nowMs, opts) {
  return (
    Math.max(occ.runAt, nowMs + opts.remindMs) <=
    occ.graderDeadlineAt - opts.runMarginMs
  );
}

/** The first occurrence from `fromIndex` on that can still be graded. */
function firstReachable(schedule, fromIndex, nowMs, opts) {
  let index = Math.max(0, fromIndex);
  const base = occurrence(schedule, 0, opts);
  // Skip whole weeks in one step; the loop below settles the last one.
  const behind = Math.floor((nowMs - base.graderDeadlineAt) / WEEK);
  if (behind > index) index = behind;
  for (let guard = 0; guard < 1000; guard++, index++) {
    const occ = occurrence(schedule, index, opts);
    if (reachable(occ, nowMs, opts)) return occ;
  }
  throw new Error("no reachable occurrence");
}

/**
 * The lesson after `currentId`, ordered by the number in the `lessonNN` id —
 * the lesson collection's own ordering (it has no order field, and the names
 * are display text). Returns {id} or {reason} when there is no single answer.
 */
function nextLessonId(currentId, lessons) {
  const number = (id) => {
    const match = /^lesson(\d+)$/.exec(String(id || ""));
    return match ? Number(match[1]) : null;
  };
  const current = number(currentId);
  if (current === null) return { reason: "unknown_order" };
  let best = null;
  let bestCount = 0;
  for (const lesson of lessons) {
    const n = number(lesson.id);
    if (n === null || n <= current) continue;
    if (best === null || n < best.n) {
      best = { n, lesson };
      bestCount = 1;
    } else if (n === best.n) {
      bestCount += 1;
    }
  }
  if (!best) return { reason: "last_lesson" };
  if (bestCount > 1) return { reason: "unknown_order" };
  return { id: best.lesson.id, name: best.lesson.name || best.lesson.id };
}

/** Deterministic job id for one week of one class. */
function scheduledJobId(classId, runKey) {
  return `s_${crypto.createHash("sha1").update(`${classId}|${runKey}`).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Notifications text (server-rendered; the bell may re-render via i18n)
// ---------------------------------------------------------------------------

const START_REASON_TEXT = {
  no_current_lesson: "lớp chưa chọn buổi hiện tại",
  google_reauth_required: "cần đăng nhập lại bằng Google",
  job_in_progress: "đang có một lượt chấm khác cho buổi này",
  no_docs: "lớp chưa có học sinh nào",
  class_not_found: "không tìm thấy lớp",
  lesson_not_found: "không tìm thấy buổi học",
  too_many_docs: "lớp có quá nhiều học sinh để chấm một lần",
  payer_not_found: "không tìm thấy giáo viên trả point",
};

function render(event, run, nowMs) {
  const where = `Lớp ${run.className || "?"} · ${run.lessonName || "?"}`;
  const at = vnParts(run.runAt).display;
  const base = {
    classId: run.classId,
    className: run.className || "",
    lessonId: run.lessonId || null,
    lessonName: run.lessonName || "",
    submitted: run.submitted ?? 0,
    total: run.totalStudents ?? 0,
    runAt: run.runAt,
    runAtText: at,
    path:
      `/grade?classId=${encodeURIComponent(run.classId)}` +
      (run.lessonId ? `&lessonId=${encodeURIComponent(run.lessonId)}` : ""),
  };
  switch (event) {
    case "upcoming": {
      const minutes = Math.max(0, Math.round((run.runAt - nowMs) / MINUTE));
      return {
        type: "grading.autoUpcoming",
        severity: "INFO",
        title: `Sắp chấm bài tự động: còn ${minutes} phút`,
        body:
          `${where}: ${base.submitted}/${base.total} học sinh đã làm bài. ` +
          `Hệ thống sẽ chấm lúc ${at}.`,
        data: { ...base, minutes },
      };
    }
    case "noSubmissions":
      return {
        type: "grading.autoCancelledNoSubmissions",
        severity: "INFO",
        title: "Huỷ chấm tự động: không có học sinh nào làm bài",
        body:
          `${where}: 0/${base.total} học sinh làm bài` +
          (run.alreadyGraded
            ? ` (${run.alreadyGraded} bài đã được chấm từ trước).`
            : ". Nếu buổi này học bù, hãy chấm tay."),
        data: { ...base, alreadyGraded: run.alreadyGraded || 0 },
      };
    case "noPoints":
      return {
        type: "grading.autoCancelledNoPoints",
        severity: "WARN",
        title: "Huỷ chấm tự động: không đủ point",
        body:
          `${where}: ${base.submitted} học sinh làm bài, cần ${run.pointsNeeded} ` +
          `point nhưng chỉ còn dùng được ${run.available}` +
          (run.reserved ? ` (đang giữ ${run.reserved} cho lớp khác)` : "") +
          ". Hãy nạp thêm point rồi chấm tay.",
        data: {
          ...base,
          need: run.pointsNeeded,
          have: run.have,
          reserved: run.reserved || 0,
          available: run.available,
        },
      };
    case "missed":
      return {
        type: "grading.autoMissed",
        severity: "WARN",
        title: "Bỏ lỡ lượt chấm tự động",
        body:
          `${where}: hệ thống không kịp chấm trước hạn ` +
          `${vnParts(run.graderDeadlineAt).display}. Hãy chấm tay.`,
        data: base,
      };
    case "needsReauth":
      return {
        type: "grading.autoNeedsReauth",
        severity: "WARN",
        title: "Huỷ chấm tự động: cần đăng nhập lại Google",
        body: `${where}: đăng nhập lại bằng Google rồi chấm tay buổi này.`,
        data: base,
      };
    case "cancelled":
      return {
        type: "grading.autoCancelledOther",
        severity: "WARN",
        title: "Huỷ chấm tự động",
        body: `${where}: ${START_REASON_TEXT[run.reason] || run.reason || "lỗi không xác định"}.`,
        data: { ...base, reason: run.reason || null },
      };
    case "done": {
      const r = run.result || {};
      const advance = run.lessonAdvance || {};
      let note = "";
      if (r.stopped) note += " Dừng giữa chừng vì hết point.";
      if (r.reauthRequired)
        note += " Dừng giữa chừng: cần đăng nhập lại Google.";
      if (advance.advanced) {
        note += ` Buổi hiện tại đã chuyển sang ${advance.lessonName}.`;
      } else if (advance.reason === "last_lesson") {
        note += " Đây là buổi cuối, không còn buổi kế tiếp.";
      } else if (advance.reason === "unknown_order") {
        note +=
          " Không xác định được buổi kế tiếp, hãy cập nhật buổi hiện tại.";
      }
      return {
        type: "grading.autoDone",
        severity: "INFO",
        title: `Đã chấm xong ${run.lessonName || ""}`.trim(),
        body:
          `${where}: ${base.submitted} học sinh làm bài, đã ghi ` +
          `${r.written ?? 0}/${r.total ?? base.total} bài, trừ ${r.charged ?? 0} point.` +
          note,
        data: {
          ...base,
          written: r.written ?? 0,
          charged: r.charged ?? 0,
          advanced: Boolean(advance.advanced),
          nextLessonName: advance.lessonName || null,
        },
      };
    }
    case "failed": {
      const r = run.result || {};
      const why =
        r.error === "not_enough_points"
          ? `không đủ point (cần ${r.errorParams?.need}, còn ${r.errorParams?.have})`
          : r.error === "google_reauth_required"
            ? "cần đăng nhập lại bằng Google"
            : r.error || "lỗi không xác định";
      return {
        type: "grading.autoFailed",
        severity: "WARN",
        title: "Chấm bài tự động không thành công",
        body: `${where}: ${why}. Hãy chấm tay.`,
        data: { ...base, error: r.error || null },
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * @param deps.db
 * @param deps.gradingJobs     { countSubmissions, createJob }
 * @param deps.enqueue         (name, payload) => Promise
 * @param deps.resolvePayer    (email, classId) => teacher|null
 * @param deps.resolveTeacher  (email) => teacher|null
 * @param deps.hasRefreshToken (email) => Promise<boolean>
 * @param deps.notify          ({id, type, severity, title, body, data, recipients}) => Promise
 * @param deps.push            ({id, type, title, body, data, recipients}) => Promise
 * @param deps.options         overrides of DEFAULTS (tests, env)
 * @param deps.now             () => ms
 */
function createGradingSchedules(deps) {
  const {
    db,
    gradingJobs,
    enqueue,
    resolvePayer,
    resolveTeacher,
    hasRefreshToken,
    notify,
    push,
    audit = null,
    now = () => Date.now(),
  } = deps;
  const lessonsForClass =
    deps.lessonsForClass || createCourses({ db, now }).lessonsForClass;
  const opts = { ...DEFAULTS, ...(deps.options || {}) };
  opts.windows = parseOffPeak(opts.offPeakUtc);

  const scheduleRef = (classId) => db.collection(SCHEDULES).doc(classId);
  const runRef = (classId, runKey) =>
    scheduleRef(classId).collection("runs").doc(runKey);
  const reservationRef = (payerId) => db.collection(RESERVATIONS).doc(payerId);
  const jobDocRef = (jobId) => db.collection("gradingJobs").doc(jobId);
  const entryKey = (classId, runKey) => `${classId}|${runKey}`;

  const remindAtOf = (next) => next.runAt - opts.remindMs;

  /** Fields that move the schedule on to its next reachable week. */
  function advanceFields(schedule, fromIndex) {
    if (!schedule.enabled) {
      return { nextStep: null, nextDueAt: null, updatedAt: now() };
    }
    const occ = firstReachable(schedule, fromIndex, now(), opts);
    return {
      next: occ,
      nextStep: "remind",
      nextDueAt: remindAtOf(occ),
      updatedAt: now(),
    };
  }

  /**
   * Reads a payer's reservations inside `tx` and drops the dead ones: run
   * gone or finished, job finished, or past its expiry. `outstanding` is what
   * the live ones may still spend.
   */
  async function readReservations(tx, payerId) {
    const ref = reservationRef(payerId);
    const snap = await tx.get(ref);
    const stored = snap.exists ? snap.data().entries || {} : {};
    const keys = Object.keys(stored);
    const refs = [];
    for (const key of keys) {
      const [classId, runKey] = key.split("|");
      refs.push(runRef(classId, runKey));
      if (stored[key].jobId) refs.push(jobDocRef(stored[key].jobId));
    }
    const snaps = refs.length ? await tx.getAll(...refs) : [];
    const entries = {};
    let outstanding = 0;
    let cursor = 0;
    for (const key of keys) {
      const entry = stored[key];
      const runSnap = snaps[cursor++];
      const jobSnap = entry.jobId ? snaps[cursor++] : null;
      const run = runSnap.exists ? runSnap.data() : null;
      const job = jobSnap?.exists ? jobSnap.data() : null;
      const dead =
        !run ||
        !RUN_ACTIVE.has(run.state) ||
        (job && JOB_TERMINAL.has(job.status)) ||
        (entry.expiresAt || 0) < now();
      if (dead) continue;
      entries[key] = entry;
      outstanding += Math.max(0, (entry.points || 0) - (job?.charged || 0));
    }
    return {
      ref,
      entries,
      outstanding,
      changed: Object.keys(entries).length !== keys.length,
    };
  }

  function writeReservations(tx, payerId, reservations) {
    tx.set(reservationRef(payerId), {
      payerTeacherId: payerId,
      entries: reservations.entries,
      updatedAt: now(),
    });
  }

  /** Sets `field` to now() if still empty; true when this call set it. */
  function claimFlag(ref, field) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data()[field]) return false;
      tx.update(ref, { [field]: now() });
      return true;
    });
  }

  /**
   * Sends the notification a phase recorded on the run ("remind", "start",
   * "done") — each at most once as a push, and re-written (same id) until its
   * flag is set. Safe to call any number of times.
   */
  async function announce(classId, runKey, phase) {
    const ref = runRef(classId, runKey);
    const snap = await ref.get();
    if (!snap.exists) return;
    const run = snap.data();
    const event = run[`${phase}Event`];
    if (!event) return;
    const message = render(event, run, now());
    if (!message) return;
    const id = crypto
      .createHash("sha1")
      .update(`grading.schedule|${classId}|${runKey}|${phase}`)
      .digest("hex");
    const recipients = run.recipients || [];
    if (!run[`${phase}NotifiedAt`]) {
      await notify({ id, ...message, recipients });
      // Same id on a retry, so a repeat overwrites rather than adds a row.
      if (audit) {
        await audit({
          id: `grading-schedule-${id}`,
          event,
          message,
          run,
        }).catch((err) =>
          console.error("[GRADING-SCHEDULE] audit failed:", err.message),
        );
      }
      await ref.update({ [`${phase}NotifiedAt`]: now() });
    }
    if (await claimFlag(ref, `${phase}PushedAt`)) {
      await push({ id, ...message, recipients }).catch((err) =>
        console.error("[GRADING-SCHEDULE] push failed:", err.message),
      );
    }
  }

  /**
   * The schedule still points at a week whose run has moved past the step it
   * is waiting for — put it back in line with the run (I2). Only reachable
   * after an edit landed on a week that was already under way.
   */
  function reconcile(tx, schedule, run) {
    if (!schedule || schedule.next?.runKey !== run.runKey) return false;
    if (run.state === "reminded" || run.state === "starting") {
      if (schedule.nextStep === "run" && schedule.nextDueAt === run.runAt) {
        return false;
      }
      tx.update(scheduleRef(run.classId), {
        next: { ...schedule.next, runAt: run.runAt },
        nextStep: "run",
        nextDueAt: run.runAt,
        updatedAt: now(),
      });
      return true;
    }
    tx.update(
      scheduleRef(run.classId),
      advanceFields(schedule, schedule.next.index + 1),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------

  async function tick() {
    const at = now();
    const snap = await db
      .collection(SCHEDULES)
      .where("nextDueAt", "<=", at)
      .limit(500)
      .get();
    const bucket = Math.floor(at / TICK_MS);
    let queued = 0;
    for (const doc of snap.docs) {
      const s = doc.data();
      if (!s.nextStep || !s.next?.runKey) continue;
      await enqueue(
        `sched-${doc.id}-${s.next.runKey}-${s.nextStep}-${bucket}`,
        {
          kind: "schedule",
          step: s.nextStep,
          classId: doc.id,
          runKey: s.next.runKey,
        },
      );
      queued += 1;
    }
    return { due: snap.size, queued };
  }

  async function handleTask(payload) {
    const classId = String(payload?.classId || "");
    const runKey = String(payload?.runKey || "");
    if (!classId || !runKey) return;
    if (payload.step === "remind") return remind(classId, runKey);
    if (payload.step === "run") return run(classId, runKey);
  }

  // -------------------------------------------------------------------------
  // remind
  // -------------------------------------------------------------------------

  /** Counts the week's submissions — reads only, so safe to repeat. */
  async function survey(schedule) {
    const classSnap = await db
      .collection("classes")
      .doc(schedule.classId)
      .get();
    if (!classSnap.exists || classSnap.data().isActive === false) {
      return { inactive: true };
    }
    const cls = classSnap.data();
    const lessonId = cls.currentLesson ? String(cls.currentLesson) : null;
    const result = {
      className: cls.name || schedule.className || "",
      lessonId,
      lessonName: "",
      failure: null,
      count: null,
    };
    if (!lessonId) {
      result.failure = "no_current_lesson";
      return result;
    }
    const lessonSnap = await db.collection("lesson").doc(lessonId).get();
    result.lessonName = lessonSnap.exists
      ? lessonSnap.data().name || lessonId
      : lessonId;
    try {
      result.count = await gradingJobs.countSubmissions({
        classId: schedule.classId,
        lessonId,
        email: schedule.ownerEmail,
        authKind: schedule.authKind,
      });
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        result.failure = "google_reauth_required";
      } else if (err instanceof JobError) {
        result.failure = err.code;
      } else {
        throw err; // transient: the step is retried
      }
    }
    return result;
  }

  async function remind(classId, runKey) {
    const schedSnap = await scheduleRef(classId).get();
    if (!schedSnap.exists) return;
    const schedule = schedSnap.data();
    if (!schedule.enabled || schedule.next?.runKey !== runKey) return;

    const existing = await runRef(classId, runKey).get();
    if (existing.exists) {
      // Decided already (I2): line the schedule up, finish the side effects.
      await db.runTransaction(async (tx) => {
        const [s, r] = await tx.getAll(
          scheduleRef(classId),
          runRef(classId, runKey),
        );
        if (s.exists && r.exists) reconcile(tx, s.data(), r.data());
      });
      return announce(classId, runKey, "remind");
    }

    const found = await survey(schedule);
    if (found.inactive) {
      await scheduleRef(classId).update({
        enabled: false,
        nextStep: null,
        nextDueAt: null,
        disabledReason: "class_inactive",
        updatedAt: now(),
      });
      info(`${classId}: class inactive, schedule switched off`);
      return;
    }

    const decided = await db.runTransaction(async (tx) => {
      const [sSnap, rSnap, pointSnap] = await tx.getAll(
        scheduleRef(classId),
        runRef(classId, runKey),
        db.collection("TeacherPoint").doc(schedule.payerTeacherId),
      );
      const reservations = await readReservations(tx, schedule.payerTeacherId);
      // ---- no writes above this line ----
      if (!sSnap.exists || rSnap.exists) return null;
      const s = sSnap.data();
      if (!s.enabled || s.next?.runKey !== runKey) return null;

      const at = now();
      const next = s.next;
      const recipients = [
        ...new Set(
          [s.ownerEmail, s.payerGmail]
            .filter(Boolean)
            .map((e) => e.toLowerCase()),
        ),
      ];
      const run = {
        classId,
        runKey,
        className: found.className,
        lessonId: found.lessonId,
        lessonName: found.lessonName,
        totalStudents: found.count?.total ?? 0,
        submitted: found.count?.pending ?? 0,
        alreadyGraded: found.count?.alreadyGraded ?? 0,
        pointsNeeded: found.count?.pending ?? 0,
        payerTeacherId: s.payerTeacherId,
        ownerEmail: s.ownerEmail,
        authKind: s.authKind,
        recipients,
        jobId: scheduledJobId(classId, runKey),
        studentDeadlineAt: next.studentDeadlineAt,
        graderDeadlineAt: next.graderDeadlineAt,
        runAt: next.runAt,
        state: null,
        reason: null,
        remindEvent: null,
        createdAt: at,
        updatedAt: at,
      };

      // A reminder this late moves grading back so the notice still holds;
      // past the point where it would still fit, the week is missed.
      if (next.runAt - at < opts.remindMs - opts.lateToleranceMs) {
        run.runAt = Math.max(next.runAt, at + opts.remindMs);
      }

      let cancelled = true;
      if (run.runAt > next.graderDeadlineAt - opts.runMarginMs) {
        run.state = "missed";
        run.remindEvent = "missed";
      } else if (found.failure) {
        run.state = "cancelled_other";
        run.reason = found.failure;
        run.remindEvent =
          found.failure === "google_reauth_required"
            ? "needsReauth"
            : "cancelled";
      } else if (run.submitted === 0) {
        run.state = "cancelled_no_submissions";
        run.remindEvent = "noSubmissions";
      } else {
        const have = pointSnap.exists ? (pointSnap.data().point ?? 0) : 0;
        const available = have - reservations.outstanding;
        if (available < run.pointsNeeded) {
          run.state = "cancelled_no_points";
          run.remindEvent = "noPoints";
          run.have = have;
          run.reserved = reservations.outstanding;
          run.available = Math.max(0, available);
        } else {
          cancelled = false;
          run.state = "reminded";
          run.remindEvent = "upcoming";
          reservations.entries[entryKey(classId, runKey)] = {
            points: run.pointsNeeded,
            jobId: run.jobId,
            expiresAt: next.graderDeadlineAt + JOB_STALE_MS,
          };
          reservations.changed = true;
        }
      }

      tx.set(runRef(classId, runKey), run);
      if (reservations.changed) {
        writeReservations(tx, s.payerTeacherId, reservations);
      }
      tx.update(
        scheduleRef(classId),
        cancelled
          ? { ...advanceFields(s, next.index + 1), lastRunKey: runKey }
          : {
              next: { ...next, runAt: run.runAt },
              nextStep: "run",
              nextDueAt: run.runAt,
              lastRunKey: runKey,
              updatedAt: at,
            },
      );
      return run;
    });

    if (!decided) return;
    info(
      `${classId}/${runKey}: ${decided.state} (${decided.submitted}/${decided.totalStudents})`,
    );
    await announce(classId, runKey, "remind");
  }

  // -------------------------------------------------------------------------
  // run
  // -------------------------------------------------------------------------

  /** Ends a run that could not start (Tx B, failure branch). */
  async function endStart(classId, runKey, { state, reason, event }) {
    await db.runTransaction(async (tx) => {
      const [sSnap, rSnap] = await tx.getAll(
        scheduleRef(classId),
        runRef(classId, runKey),
      );
      if (!rSnap.exists) return;
      const r = rSnap.data();
      const reservations = await readReservations(tx, r.payerTeacherId);
      const s = sSnap.exists ? sSnap.data() : null;
      if (r.state !== "starting") {
        if (s) reconcile(tx, s, r);
        return;
      }
      tx.update(rSnap.ref, {
        state,
        reason,
        startEvent: event,
        updatedAt: now(),
      });
      delete reservations.entries[entryKey(classId, runKey)];
      writeReservations(tx, r.payerTeacherId, reservations);
      if (s && s.next?.runKey === runKey) {
        tx.update(sSnap.ref, advanceFields(s, s.next.index + 1));
      }
    });
    await announce(classId, runKey, "start");
  }

  async function run(classId, runKey) {
    // Tx A: reminded → starting.
    const claim = await db.runTransaction(async (tx) => {
      const [sSnap, rSnap] = await tx.getAll(
        scheduleRef(classId),
        runRef(classId, runKey),
      );
      if (!rSnap.exists) return { stop: true };
      const r = rSnap.data();
      if (r.state === "reminded") {
        if (now() < r.runAt) return { early: true };
        tx.update(rSnap.ref, { state: "starting", updatedAt: now() });
        return { run: { ...r, state: "starting" } };
      }
      if (r.state === "starting") return { run: r };
      if (sSnap.exists) reconcile(tx, sSnap.data(), r);
      return { stop: true };
    });
    if (claim.early) throw new RetryLater("not_yet");
    if (claim.stop) return;
    const r = claim.run;

    let started = false;
    try {
      await gradingJobs.createJob({
        email: r.ownerEmail,
        authKind: r.authKind,
        isAdmin: false,
        classId,
        lessonId: r.lessonId,
        useCache: true,
        jobId: r.jobId,
        origin: { type: "schedule", classId, runKey },
        guard: async (tx) => {
          const [gs, gr] = await tx.getAll(
            scheduleRef(classId),
            runRef(classId, runKey),
          );
          return (
            gr.exists &&
            gr.data().state === "starting" &&
            gs.exists &&
            gs.data().enabled === true &&
            now() <= gr.data().graderDeadlineAt
          );
        },
      });
      started = true;
    } catch (err) {
      if (!(err instanceof JobError)) throw err;
      if (err.code === "guard_rejected") {
        // Either switched off meanwhile (the run is no longer "starting" and
        // endStart only reconciles) or the grader deadline has passed.
        return endStart(classId, runKey, {
          state: "missed",
          reason: null,
          event: "missed",
        });
      }
      if (!PERMANENT_START_ERRORS.has(err.code)) throw err; // retried
      return endStart(classId, runKey, {
        state: "cancelled_other",
        reason: err.code,
        event:
          err.code === "google_reauth_required" ? "needsReauth" : "cancelled",
      });
    }

    if (!started) return;
    // Tx B: starting → running, and the schedule moves to next week.
    await db.runTransaction(async (tx) => {
      const [sSnap, rSnap] = await tx.getAll(
        scheduleRef(classId),
        runRef(classId, runKey),
      );
      if (!rSnap.exists) return;
      const cur = rSnap.data();
      const s = sSnap.exists ? sSnap.data() : null;
      if (cur.state !== "starting") {
        if (s) reconcile(tx, s, cur);
        return;
      }
      tx.update(rSnap.ref, {
        state: "running",
        startedAt: now(),
        updatedAt: now(),
      });
      if (s && s.next?.runKey === runKey) {
        tx.update(sSnap.ref, advanceFields(s, s.next.index + 1));
      }
    });
    info(`${classId}/${runKey}: job ${r.jobId} started`);
  }

  // -------------------------------------------------------------------------
  // the end of a scheduled job — the ONLY owner
  // -------------------------------------------------------------------------

  /**
   * Called from gradingJobs' finalize (via server.js) for every job whose
   * origin is a schedule — at least once, so every part below is guarded by
   * its own flag and any of them may be the one still missing on a retry.
   */
  async function onJobFinished(job) {
    const classId = job.origin?.classId;
    const runKey = job.origin?.runKey;
    if (!classId || !runKey) return;

    // Reference data, read outside the transaction.
    const classSnap = await db.collection("classes").doc(classId).get();
    let next = { reason: "unknown_order" };
    if (classSnap.exists) {
      // The class's course decides which lessons exist (legacy classes: the
      // old template lookup) — see lib/courses.js.
      next = nextLessonId(
        job.lessonId,
        await lessonsForClass(classSnap.data()),
      );
    }

    await db.runTransaction(async (tx) => {
      const [rSnap, cSnap] = await tx.getAll(
        runRef(classId, runKey),
        db.collection("classes").doc(classId),
      );
      if (!rSnap.exists) return;
      const r = rSnap.data();
      const reservations = await readReservations(tx, r.payerTeacherId);
      // ---- no writes above this line ----
      const update = {};
      if (RUN_ACTIVE.has(r.state)) {
        const ok = job.status === "done";
        Object.assign(update, {
          state: ok ? "done" : "failed",
          doneEvent: ok ? "done" : "failed",
          finishedAt: now(),
          result: {
            written: job.written ?? 0,
            total: job.total ?? 0,
            charged: job.charged ?? 0,
            skipped: job.skipped ?? 0,
            failed: job.failed ?? 0,
            stopped: Boolean(job.stopped),
            reauthRequired: Boolean(job.reauthRequired),
            error: job.error || null,
            errorParams: job.errorParams || null,
          },
        });
      }
      const key = entryKey(classId, runKey);
      if (reservations.entries[key] || reservations.changed) {
        delete reservations.entries[key];
        writeReservations(tx, r.payerTeacherId, reservations);
      }
      if (!r.lessonAdvancedAt) {
        const cls = cSnap.exists ? cSnap.data() : null;
        let decision;
        if (job.status !== "done" || !(job.written > 0)) {
          decision = { advanced: false, reason: "nothing_written" };
        } else if (job.stopped || job.reauthRequired) {
          decision = { advanced: false, reason: "partial" };
        } else if (!cls || cls.currentLesson !== job.lessonId) {
          decision = { advanced: false, reason: "changed" };
        } else if (!next.id) {
          decision = { advanced: false, reason: next.reason };
        } else {
          decision = {
            advanced: true,
            lessonId: next.id,
            lessonName: next.name,
          };
          tx.update(cSnap.ref, { currentLesson: next.id });
        }
        update.lessonAdvance = decision;
        update.lessonAdvancedAt = now();
      }
      if (Object.keys(update).length) {
        tx.update(rSnap.ref, { ...update, updatedAt: now() });
      }
    });
    await announce(classId, runKey, "done");
  }

  // -------------------------------------------------------------------------
  // teacher-facing: set up, switch off, read
  // -------------------------------------------------------------------------

  /** The class, if the viewer may manage its schedule. */
  async function loadManagedClass(viewer, classId) {
    classId = String(classId || "");
    if (!classId) throw new JobError(400, "classId_required");
    const snap = await db.collection("classes").doc(classId).get();
    if (!snap.exists) throw new JobError(404, "class_not_found");
    const cls = snap.data();
    if (!viewer.isAdmin) {
      const teacher = await resolveTeacher(viewer.email);
      const ids = Array.isArray(cls.teacherId) ? cls.teacherId : [];
      if (!teacher || !ids.includes(teacher.id)) {
        throw new JobError(403, "not_your_class");
      }
    }
    return { id: classId, ...cls };
  }

  /** Validates two first-week deadlines and derives the weekly definition. */
  function define(classId, studentDeadlineAt, graderDeadlineAt) {
    const s = Number(studentDeadlineAt);
    const g = Number(graderDeadlineAt);
    if (!Number.isFinite(s) || !Number.isFinite(g)) {
      throw new JobError(400, "invalid_deadlines");
    }
    const gapMs = g - s;
    if (gapMs < opts.minGapMs) {
      throw new JobError(400, "deadline_gap_too_short", {
        minHours: opts.minGapMs / HOUR,
      });
    }
    if (gapMs > opts.maxGapMs) throw new JobError(400, "deadline_gap_too_long");
    const sp = vnParts(s);
    const gp = vnParts(g);
    return {
      classId,
      anchorStudentAt: s,
      gapMs,
      studentDeadline: { weekday: sp.weekday, time: sp.time },
      graderDeadline: { weekday: gp.weekday, time: gp.time },
    };
  }

  /** Side-effect free: what saving these deadlines would schedule. */
  async function preview({
    viewer,
    classId,
    studentDeadlineAt,
    graderDeadlineAt,
  }) {
    const cls = await loadManagedClass(viewer, classId);
    const def = define(cls.id, studentDeadlineAt, graderDeadlineAt);
    const occ = firstReachable(def, 0, now(), opts);
    return {
      ...def,
      next: { ...occ, remindAt: remindAtOf(occ) },
    };
  }

  /**
   * What an unfinished week becomes when its schedule is edited or switched
   * off. `mode` "edit": a week not yet started is forgotten (deleted) so the
   * new times can plan it again; "disable": it is cancelled.
   */
  function settleOpenRun(tx, run, jobExists, reservations, mode) {
    if (!run) return { keep: false };
    const key = entryKey(run.classId, run.runKey);
    const notStarted =
      run.state === "reminded" || (run.state === "starting" && !jobExists);
    if (notStarted) {
      if (mode === "edit") {
        tx.delete(runRef(run.classId, run.runKey));
      } else {
        tx.update(runRef(run.classId, run.runKey), {
          state: "cancelled_other",
          reason: "schedule_disabled",
          updatedAt: now(),
        });
      }
      if (reservations.entries[key]) {
        delete reservations.entries[key];
        reservations.changed = true;
      }
      return { keep: false, freed: true };
    }
    // Started (or finished): it runs to its end; onJobFinished closes it.
    return { keep: run.state === "starting" };
  }

  async function upsert({
    viewer,
    classId,
    studentDeadlineAt,
    graderDeadlineAt,
  }) {
    const cls = await loadManagedClass(viewer, classId);
    if (cls.isActive === false) throw new JobError(409, "class_inactive");
    if (!cls.currentLesson) throw new JobError(409, "no_current_lesson");
    const def = define(cls.id, studentDeadlineAt, graderDeadlineAt);
    const email = String(viewer.email || "").toLowerCase();
    const authKind = viewer.authKind === "google" ? "google" : "jwt";
    if (authKind === "google" && !(await hasRefreshToken(email))) {
      throw new JobError(409, "google_reauth_required");
    }
    const payer = await resolvePayer(email, cls.id);
    if (!payer) throw new JobError(403, "payer_not_found");

    // Candidate first weeks, in order; the first with no run of its own wins.
    const first = firstReachable(def, 0, now(), opts);
    const candidates = [0, 1, 2].map((k) =>
      occurrence(def, first.index + k, opts),
    );

    const saved = await db.runTransaction(async (tx) => {
      const sSnap = await tx.get(scheduleRef(cls.id));
      const old = sSnap.exists ? sSnap.data() : null;
      const oldRunSnap = old?.next?.runKey
        ? await tx.get(runRef(cls.id, old.next.runKey))
        : null;
      const oldRun = oldRunSnap?.exists ? oldRunSnap.data() : null;
      const oldJob = oldRun?.jobId
        ? await tx.get(jobDocRef(oldRun.jobId))
        : null;
      const candidateSnaps = await tx.getAll(
        ...candidates.map((c) => runRef(cls.id, c.runKey)),
      );
      const payerIds = [
        ...new Set([oldRun?.payerTeacherId, payer.id].filter(Boolean)),
      ];
      const reservationsByPayer = {};
      for (const id of payerIds) {
        reservationsByPayer[id] = await readReservations(tx, id);
      }
      // ---- no writes above this line ----
      if (oldRun) {
        settleOpenRun(
          tx,
          oldRun,
          oldJob?.exists,
          reservationsByPayer[oldRun.payerTeacherId],
          "edit",
        );
      }
      const freeIndex = candidates.findIndex((c, i) => {
        if (!candidateSnaps[i].exists) return true;
        // The old week's run we are about to delete counts as free.
        return (
          oldRun &&
          c.runKey === oldRun.runKey &&
          (oldRun.state === "reminded" ||
            (oldRun.state === "starting" && !oldJob?.exists))
        );
      });
      const occ =
        candidates[freeIndex >= 0 ? freeIndex : candidates.length - 1];
      const at = now();
      const doc = {
        ...def,
        className: cls.name || "",
        ownerEmail: email,
        authKind,
        payerTeacherId: payer.id,
        payerGmail: String(payer.gmail || "").toLowerCase(),
        enabled: true,
        disabledReason: null,
        next: occ,
        nextStep: "remind",
        nextDueAt: remindAtOf(occ),
        lastRunKey: old?.lastRunKey || null,
        createdAt: old?.createdAt || at,
        updatedAt: at,
        updatedByEmail: email,
      };
      tx.set(scheduleRef(cls.id), doc);
      for (const id of payerIds) {
        if (reservationsByPayer[id].changed) {
          writeReservations(tx, id, reservationsByPayer[id]);
        }
      }
      return doc;
    });
    return toClient(saved, null);
  }

  async function disable({ viewer, classId }) {
    const cls = await loadManagedClass(viewer, classId);
    await db.runTransaction(async (tx) => {
      const sSnap = await tx.get(scheduleRef(cls.id));
      if (!sSnap.exists) return;
      const s = sSnap.data();
      const runSnap = s.next?.runKey
        ? await tx.get(runRef(cls.id, s.next.runKey))
        : null;
      const r = runSnap?.exists ? runSnap.data() : null;
      const jobSnap = r?.jobId ? await tx.get(jobDocRef(r.jobId)) : null;
      const reservations = r
        ? await readReservations(tx, r.payerTeacherId)
        : null;
      // ---- no writes above this line ----
      const { keep } = r
        ? settleOpenRun(tx, r, jobSnap?.exists, reservations, "disable")
        : { keep: false };
      if (reservations?.changed)
        writeReservations(tx, r.payerTeacherId, reservations);
      tx.update(sSnap.ref, {
        enabled: false,
        disabledReason: "by_teacher",
        // A week whose job already exists keeps its step so Tx B can finish.
        nextStep: keep ? s.nextStep : null,
        nextDueAt: keep ? s.nextDueAt : null,
        updatedAt: now(),
        updatedByEmail: String(viewer.email || "").toLowerCase(),
      });
    });
    return { ok: true };
  }

  function toClient(s, lastRun) {
    if (!s) return null;
    return {
      classId: s.classId,
      className: s.className,
      enabled: Boolean(s.enabled),
      studentDeadline: s.studentDeadline,
      graderDeadline: s.graderDeadline,
      anchorStudentAt: s.anchorStudentAt,
      gapMs: s.gapMs,
      next:
        s.enabled && s.next
          ? {
              runKey: s.next.runKey,
              studentDeadlineAt: s.next.studentDeadlineAt,
              graderDeadlineAt: s.next.graderDeadlineAt,
              runAt: s.next.runAt,
              remindAt: remindAtOf(s.next),
              offPeak: Boolean(s.next.offPeak),
            }
          : null,
      nextStep: s.nextStep || null,
      lastRun: lastRun
        ? {
            runKey: lastRun.runKey,
            state: lastRun.state,
            reason: lastRun.reason || null,
            lessonName: lastRun.lessonName || "",
            submitted: lastRun.submitted ?? 0,
            total: lastRun.totalStudents ?? 0,
            runAt: lastRun.runAt,
            result: lastRun.result || null,
            updatedAt: lastRun.updatedAt || null,
          }
        : null,
    };
  }

  async function get({ viewer, classId }) {
    const cls = await loadManagedClass(viewer, classId);
    const snap = await scheduleRef(cls.id).get();
    if (!snap.exists) return null;
    const s = snap.data();
    const last = s.lastRunKey ? await runRef(cls.id, s.lastRunKey).get() : null;
    return toClient(s, last?.exists ? last.data() : null);
  }

  /** Schedules of the given classes (the caller decides which it may see). */
  async function listFor(classIds) {
    const ids = [...new Set((classIds || []).map(String).filter(Boolean))];
    if (!ids.length) return [];
    const snaps = await db.getAll(...ids.map((id) => scheduleRef(id)));
    return snaps.filter((s) => s.exists).map((s) => toClient(s.data(), null));
  }

  /**
   * The most the payer's scheduled classes can cost next time — every student
   * with a doc — against the balance. Shown when setting up a schedule.
   */
  async function estimate(payerTeacherId, { includeClassId = null } = {}) {
    const [pointSnap, schedSnap] = await Promise.all([
      db.collection("TeacherPoint").doc(payerTeacherId).get(),
      db
        .collection(SCHEDULES)
        .where("payerTeacherId", "==", payerTeacherId)
        .get(),
    ]);
    const countStudents = async (classId) => {
      const students = await db
        .collection("students")
        .where("classId", "==", classId)
        .get();
      let count = 0;
      students.forEach((st) => {
        if (String(st.data().ggDocLink || "").trim()) count += 1;
      });
      return count;
    };
    const classes = [];
    for (const doc of schedSnap.docs) {
      const sched = doc.data();
      if (!sched.enabled) continue;
      classes.push({
        classId: doc.id,
        className: sched.className || "",
        students: await countStudents(doc.id),
        runAt: sched.next?.runAt ?? null,
      });
    }
    // The class being set up counts too, before its schedule is saved.
    if (includeClassId && !classes.some((c) => c.classId === includeClassId)) {
      const cls = await db.collection("classes").doc(includeClassId).get();
      if (cls.exists) {
        classes.push({
          classId: includeClassId,
          className: cls.data().name || "",
          students: await countStudents(includeClassId),
          runAt: null,
        });
      }
    }
    return {
      point: pointSnap.exists ? (pointSnap.data().point ?? 0) : 0,
      needMax: classes.reduce((sum, c) => sum + c.students, 0),
      classes,
    };
  }

  return {
    disable,
    estimate,
    get,
    handleTask,
    listFor,
    onJobFinished,
    preview,
    tick,
    upsert,
    // exposed for tests
    remind,
    run,
    options: opts,
  };
}

/**
 * Wraps gradingJobs' `onFinished` hooks so a scheduled job's end has ONE
 * owner: its notify goes to onJobFinished (run state, reservation, bell +
 * push, lesson move) and its own push is skipped — the regular job
 * notification is never sent for it. Everything else is passed through.
 * `getSchedules` is a thunk because the two services reference each other.
 */
function scheduleAwareOnFinished(base, getSchedules) {
  const isScheduled = (job) => job?.origin?.type === "schedule";
  return {
    recordSummary: (job) => base.recordSummary(job),
    notify: (job) =>
      isScheduled(job) ? getSchedules().onJobFinished(job) : base.notify(job),
    push: async (job) => (isScheduled(job) ? undefined : base.push(job)),
  };
}

module.exports = {
  DEFAULTS,
  TICK_MS,
  WEEK,
  createGradingSchedules,
  scheduleAwareOnFinished,
  firstReachable,
  jitterFor,
  nextLessonId,
  occurrence,
  offPeakSegments,
  parseOffPeak,
  pickRunAt,
  render,
  scheduledJobId,
  vnParts,
};
