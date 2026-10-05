/**
 * Scheduled grading: every class may have one weekly schedule — the days of
 * the week it is graded on, each in the morning, afternoon or evening — and
 * the backend grades the class's current lesson then, at the time an admin
 * sets for that part of the day: one default per part for every class
 * (appSettings/gradingSchedule.runTimes) or the class's own. Teachers only
 * pick days and parts; the admin keeps the actual hours out of peak time. The
 * teacher hears about it twice: ~30 minutes before ("N students did the
 * homework, grading at HH:mm") and once it is done. A week nobody handed
 * anything in, or one the points cannot cover, is cancelled at the reminder
 * instead, with a notification saying why.
 *
 * Schedules saved before grading days existed keep their two deadlines per
 * slot (the students' and the teacher's) and are graded between them,
 * preferably off-peak, until someone saves them again.
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
 * BALANCE. At the reminder the week's need (the students who did the homework,
 * at the auto price — lib/billing.js PRICE_AUTO_VND) is reserved in
 * `pointReservations/{payerTeacherId}` — one document per payer,
 * read and written by every reminder of that payer's classes, which makes it
 * the point where they serialise. Invariant (P): at the moment a reminder
 * commits, balanceVnd ≥ Σ max(0, reserved_i − charged_i) × price_i over the
 * live reservations (reserved/charged count docs), the new one included. The transaction reads TeacherPoint, the
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

const { PRICE_AUTO_VND, balanceVndOf, formatVnd } = require("./billing.js");
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
/** The admin's settings, {runTimes: {part: "HH:mm"}}: the default times. */
const SETTINGS = { collection: "appSettings", doc: "gradingSchedule" };

/**
 * The parts of a day a teacher picks from, and the hours (Vietnam, minutes of
 * the day, [from, to)) an admin may set each one's time within. Keeping each
 * part inside its own stretch keeps the grading days of one schedule apart: an
 * evening run with all its lateness still ends before the next morning's
 * reminder.
 */
const PARTS = {
  morning: { from: 4 * 60, to: 12 * 60 },
  afternoon: { from: 12 * 60, to: 18 * 60 },
  evening: { from: 18 * 60, to: 24 * 60 },
};

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
  /**
   * Grading time of each part of the day (Vietnam) until an admin sets
   * another — all off-peak. DeepSeek's peak (double price) is Monday to
   * Friday 8:00–11:00 and 13:00–17:00 Vietnam time; the afternoon waits until
   * 17:00, after which nothing is peak until the next morning.
   */
  runTimes: { morning: "07:00", afternoon: "17:00", evening: "23:30" },
  /**
   * How late a grading day's run may still start (an outage, a slow queue)
   * before the week is missed instead of graded into peak hours.
   */
  lateStartMs: 2 * HOUR,
  /** Shortest allowed gap between a legacy slot's two deadlines. */
  minGapMs: 2 * HOUR,
  maxGapMs: WEEK,
  /** One grading day per weekday at most. */
  maxSlots: 7,
  /**
   * Classes on the default time are spread over this much after it (legacy
   * slots: over this much of the off-peak window). A class's own time is kept
   * to the minute.
   */
  jitterMs: 20 * MINUTE,
  /**
   * A reminder this late (tick lag, an outage) pushes grading back so the
   * teacher still gets roughly the promised notice. Normal tick lag (≤ 5 min)
   * stays under it, so the planned — off-peak — time is kept.
   */
  lateToleranceMs: 10 * MINUTE,
  /**
   * Off-peak window for legacy (deadline) slots, UTC. 16:30–00:30 UTC =
   * 23:30–07:30 in Vietnam: DeepSeek's old discount window, and still inside
   * its current off-peak hours (everything but weekdays 8:00–11:00 and
   * 13:00–17:00 Vietnam time).
   */
  offPeakUtc: "16:30-00:30",
};

const RUN_ACTIVE = new Set(["reminded", "starting", "running"]);

/** Most runs one class can have on one day (re-grades: base, -r2 … -r20). */
const MAX_RETAKES = 20;

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
    // dd/mm/yyyy HH:mm — the website's formatDateTimeVn.
    display: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** Midnight (Vietnam) of the day `ms` falls on. */
function vnDayStart(ms) {
  return Math.floor((ms + VN_OFFSET_MS) / DAY) * DAY - VN_OFFSET_MS;
}

/** "2026-10-08" → that day's midnight in Vietnam (epoch ms), NaN if invalid. */
function parseVnDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return NaN;
  const [y, m, d] = match.slice(1).map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return NaN;
  return ms - VN_OFFSET_MS;
}

/** "HH:mm" (00:00–23:59) → minutes of the day, or null. */
function parseRunTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const [h, m] = [Number(match[1]), Number(match[2])];
  return h < 24 && m < 60 ? h * 60 + m : null;
}

/** `value` if it is a time ("HH:mm") inside `part`'s hours, else null. */
function partTime(part, value) {
  const range = PARTS[part];
  const minutes = parseRunTime(value);
  return range &&
    minutes !== null &&
    minutes >= range.from &&
    minutes < range.to
    ? String(value).trim()
    : null;
}

/** The valid entries of a {part: "HH:mm"} map. */
function cleanRunTimes(map) {
  const out = {};
  for (const part of Object.keys(PARTS)) {
    const value = partTime(part, map?.[part]);
    if (value) out[part] = value;
  }
  return out;
}

function inOffPeak(ms, windows) {
  return offPeakSegments(ms, ms, windows).some(
    (seg) => seg.start <= ms && ms < seg.end,
  );
}

/**
 * The weekly slots of a schedule — one per grading day of the week — in week
 * order, each {anchorDayAt, part}: the first grading day's midnight (Vietnam)
 * and the part of the day (morning, afternoon, evening) it is graded in. A
 * legacy slot is {anchorStudentAt, gapMs} instead: the first students'
 * deadline and how long after it the teacher's deadline falls. Either way
 * `define` keeps them sorted within one week of the first and never
 * overlapping (a slot's grading deadline is at or before the next slot's
 * students' deadline), so the occurrences of all slots, taken in index order,
 * are in time order and at most one is ever open. A schedule saved before
 * slots existed is one slot.
 */
function slotsOf(schedule) {
  if (Array.isArray(schedule.slots) && schedule.slots.length) {
    return schedule.slots;
  }
  return [{ anchorStudentAt: schedule.anchorStudentAt, gapMs: schedule.gapMs }];
}

/** One occurrence's id: the students' deadline, Vietnam time (2026-09-29-2000). */
function runKeyOf(studentDeadlineAt) {
  const p = vnParts(studentDeadlineAt);
  return `${p.date}-${p.time.replace(":", "")}`;
}

/** A slot's part of the day (a slot from before parts: morning). */
const partOf = (slot) => (PARTS[slot.part] ? slot.part : "morning");

/**
 * One grading day: graded at the schedule's time for the slot's part of the
 * day — a default time spread by the class's jitter, the class's own one to
 * the minute. Its "deadlines" frame that time — the students' is when the
 * reminder's count is taken, less the grace; the teacher's is the last moment
 * a late run may still start, plus the margin. The run key is the day
 * (2026-10-08), so moving the time keeps the week's identity, and a day is
 * never graded twice by one schedule.
 */
function dayOccurrence(schedule, slot, dayAt, opts) {
  const part = partOf(slot);
  const minutes =
    parseRunTime(schedule.runTimes?.[part]) ??
    parseRunTime(opts.runTimes[part]);
  const planned = dayAt + minutes * MINUTE;
  const own = Boolean(cleanRunTimes(schedule.customRunTimes)[part]);
  // The spread never carries a run out of its part of the day: a morning set
  // to 11:55 stays a morning (not 12:07), an evening at 23:55 stays on the
  // day the teacher picked (not "00:07 tomorrow").
  const partEnd = dayAt + (PARTS[part]?.to ?? 24 * 60) * MINUTE;
  const room = Math.max(0, partEnd - MINUTE - planned);
  const runAt =
    planned +
    (own ? 0 : jitterFor(schedule.classId, Math.min(opts.jitterMs, room)));
  return {
    runKey: vnParts(dayAt).date,
    studentDeadlineAt: planned - opts.remindMs - opts.graceMs,
    graderDeadlineAt: runAt + opts.lateStartMs + opts.runMarginMs,
    runAt,
    offPeak: inOffPeak(runAt, opts.windows),
  };
}

/** A legacy slot's week: graded between its deadlines, preferably off-peak. */
function deadlineOccurrence(schedule, studentDeadlineAt, gapMs, opts) {
  const graderDeadlineAt = studentDeadlineAt + gapMs;
  const ws = studentDeadlineAt + opts.graceMs + opts.remindMs;
  const we = graderDeadlineAt - opts.runMarginMs;
  if (we < ws) throw new Error("schedule window is too short");
  const { runAt, offPeak } = pickRunAt({
    ws,
    we,
    jitter: jitterFor(schedule.classId, opts.jitterMs),
    windows: opts.windows,
  });
  return {
    runKey: runKeyOf(studentDeadlineAt),
    studentDeadlineAt,
    graderDeadlineAt,
    runAt,
    offPeak,
  };
}

/**
 * Occurrence `index` of a schedule — slot `index mod n` of week
 * `floor(index / n)`: its two deadlines, run key and when grading happens.
 * Asserts the time invariant
 *   studentDeadline + grace ≤ runAt − remind < runAt ≤ graderDeadline − margin
 * which a grading day has by construction and a legacy slot by its minimum gap.
 */
function occurrence(schedule, index, opts) {
  const slots = slotsOf(schedule);
  const n = slots.length;
  const slot = slots[((index % n) + n) % n];
  const week = Math.floor(index / n) * WEEK;
  const occ = Number.isFinite(slot.anchorDayAt)
    ? dayOccurrence(schedule, slot, slot.anchorDayAt + week, opts)
    : deadlineOccurrence(
        schedule,
        slot.anchorStudentAt + week,
        slot.gapMs,
        opts,
      );
  if (
    !(occ.studentDeadlineAt + opts.graceMs <= occ.runAt - opts.remindMs) ||
    !(occ.runAt <= occ.graderDeadlineAt - opts.runMarginMs)
  ) {
    throw new Error("schedule time invariant violated");
  }
  return { index, ...occ };
}

/** True when a schedule is made of grading days (not legacy deadlines). */
function isDaySchedule(schedule) {
  return slotsOf(schedule).every((slot) => Number.isFinite(slot.anchorDayAt));
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
  const n = slotsOf(schedule).length;
  const base = occurrence(schedule, 0, opts);
  // Skip whole weeks in one step — all but the last one surely over (slots
  // end within a week of the first) — and let the loop settle the rest.
  const behind = Math.floor((nowMs - base.graderDeadlineAt) / WEEK) - 1;
  if (behind * n > index) index = behind * n;
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
  payer_not_found: "không tìm thấy giáo viên trả tiền chấm",
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
        title: "Huỷ chấm tự động: không đủ số dư",
        body:
          `${where}: ${base.submitted} học sinh làm bài, cần ` +
          `${formatVnd(run.needVnd)} nhưng chỉ còn dùng được ` +
          formatVnd(run.available) +
          (run.reserved
            ? ` (đang giữ ${formatVnd(run.reserved)} cho lớp khác)`
            : "") +
          ". Hãy nạp thêm tiền rồi chấm tay.",
        data: {
          ...base,
          need: run.pointsNeeded,
          needVnd: run.needVnd,
          haveVnd: run.have,
          reservedVnd: run.reserved || 0,
          availableVnd: run.available,
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
      if (r.stopped) note += " Dừng giữa chừng vì hết số dư.";
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
          `${r.written ?? 0}/${r.total ?? base.total} bài, trừ ` +
          `${formatVnd(r.chargedVnd ?? 0)}` +
          (r.alreadyPaid
            ? ` (${r.alreadyPaid} bài đã trả tiền trước đó nên không trừ lại)`
            : "") +
          "." +
          note,
        data: {
          ...base,
          written: r.written ?? 0,
          charged: r.charged ?? 0,
          chargedVnd: r.chargedVnd ?? 0,
          alreadyPaid: r.alreadyPaid ?? 0,
          advanced: Boolean(advance.advanced),
          nextLessonName: advance.lessonName || null,
        },
      };
    }
    case "failed": {
      const r = run.result || {};
      const why =
        r.error === "not_enough_points"
          ? `không đủ số dư (cần ${formatVnd(r.errorParams?.needVnd)}, ` +
            `còn ${formatVnd(r.errorParams?.haveVnd)})`
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

  const settingsRef = () =>
    db.collection(SETTINGS.collection).doc(SETTINGS.doc);
  /** The admin's default time of every part, from the settings doc. */
  const defaultRunTimesOf = (snap) => ({
    ...opts.runTimes,
    ...cleanRunTimes(snap?.exists ? snap.data().runTimes : null),
  });
  const readDefaultRunTimes = async () =>
    defaultRunTimesOf(await settingsRef().get());

  /**
   * A schedule's time fields: `customRunTimes`, the class's own times (some
   * parts or none), and `runTimes`, every part's effective time.
   */
  function runTimeFields(customRunTimes, defaultRunTimes) {
    const own = cleanRunTimes(customRunTimes);
    return {
      runTimes: { ...defaultRunTimes, ...own },
      customRunTimes: own,
    };
  }

  /**
   * Where candidate week `c` can go. A day's runs chain base, base-r2,
   * base-r3…: a day whose last run is over (done, failed, cancelled, missed)
   * can be graded again under the next key — a re-grade — so the earlier run,
   * its job, notices and audit rows stay exactly as they were. A day whose
   * last run is still under way is taken, unless it is the run this save is
   * about to forget (`forgottenKey`). `get(ref)` reads in or out of a
   * transaction. Returns {runKey, replaces} or {takenKey}.
   */
  async function placeCandidate(get, classId, c, baseSnap, forgottenKey) {
    if (!baseSnap.exists) return { runKey: c.runKey, replaces: null };
    let key = c.runKey;
    let snap = baseSnap;
    for (let k = 2; k <= MAX_RETAKES; k++) {
      const nextKey = `${c.runKey}-r${k}`;
      const nextSnap = await get(runRef(classId, nextKey));
      if (!nextSnap.exists) {
        if (key === forgottenKey) return { runKey: key, replaces: null };
        if (RUN_ACTIVE.has(snap.data().state)) return { takenKey: key };
        return { runKey: nextKey, replaces: key };
      }
      key = nextKey;
      snap = nextSnap;
    }
    return { takenKey: key };
  }

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
      // In VND: docs still to charge × that reservation's price per doc.
      outstanding +=
        Math.max(0, (entry.points || 0) - (job?.charged || 0)) *
        (entry.priceVnd ?? PRICE_AUTO_VND);
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
        needVnd: (found.count?.pending ?? 0) * PRICE_AUTO_VND,
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
        // All in VND: the balance, what other reminders hold, what is free.
        const have = pointSnap.exists ? balanceVndOf(pointSnap.data()) : 0;
        const available = have - reservations.outstanding;
        if (available < run.needVnd) {
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
            priceVnd: PRICE_AUTO_VND,
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
            alreadyPaid: job.alreadyPaid ?? 0,
            chargedVnd:
              (job.charged ?? 0) * (job.unitPriceVnd ?? PRICE_AUTO_VND),
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

  /**
   * The slots a request asks for: `slots` [{date: "YYYY-MM-DD", part}]
   * (grading days), [{studentDeadlineAt, graderDeadlineAt}] from a website
   * before grading days, or the single pair of one from before slots.
   */
  function slotInput({ slots, studentDeadlineAt, graderDeadlineAt }) {
    if (Array.isArray(slots)) return slots;
    return [{ studentDeadlineAt, graderDeadlineAt }];
  }

  /**
   * Validates the first grading day (and its part of the day) of every weekly
   * slot and derives the weekly definition: days sorted within one week of
   * the earliest, one per weekday.
   */
  function defineDays(classId, input) {
    const raw = input.map((slot, i) => {
      const dayAt = parseVnDate(slot?.date);
      if (!Number.isFinite(dayAt)) {
        throw new JobError(400, "invalid_date", { slot: i + 1 });
      }
      if (!PARTS[slot?.part]) {
        throw new JobError(400, "invalid_part", { slot: i + 1 });
      }
      return { dayAt, part: slot.part, input: i + 1 };
    });
    const first = Math.min(...raw.map((r) => r.dayAt));
    const days = raw
      .map((r) => ({
        ...r,
        dayAt: r.dayAt - Math.floor((r.dayAt - first) / WEEK) * WEEK,
      }))
      .sort((a, b) => a.dayAt - b.dayAt || a.input - b.input);
    days.forEach((day, i) => {
      if (i > 0 && days[i - 1].dayAt === day.dayAt) {
        throw new JobError(400, "slots_same_day", {
          slot: days[i - 1].input,
          other: day.input,
        });
      }
    });
    return {
      classId,
      slots: days.map(({ dayAt, part }) => ({
        anchorDayAt: dayAt,
        part,
        weekday: vnParts(dayAt).weekday,
      })),
    };
  }

  /**
   * The weekly definition a request asks for — grading days, or (a website
   * from before them) the deadlines of every weekly slot: slots sorted within
   * one week of the earliest, each one's grading deadline no later than the
   * next one's students' deadline.
   */
  function define(classId, input) {
    if (!Array.isArray(input) || input.length === 0) {
      throw new JobError(400, "slots_required");
    }
    if (input.length > opts.maxSlots) {
      throw new JobError(400, "too_many_slots", { max: opts.maxSlots });
    }
    if (input.some((slot) => slot?.date !== undefined)) {
      return defineDays(classId, input);
    }
    const raw = input.map((slot, i) => {
      const s = Number(slot?.studentDeadlineAt);
      const g = Number(slot?.graderDeadlineAt);
      if (!Number.isFinite(s) || !Number.isFinite(g)) {
        throw new JobError(400, "invalid_deadlines", { slot: i + 1 });
      }
      const gapMs = g - s;
      if (gapMs < opts.minGapMs) {
        throw new JobError(400, "deadline_gap_too_short", {
          minHours: opts.minGapMs / HOUR,
          slot: i + 1,
        });
      }
      if (gapMs > opts.maxGapMs) {
        throw new JobError(400, "deadline_gap_too_long", { slot: i + 1 });
      }
      return { s, gapMs, input: i + 1 };
    });
    // Bring every slot into the week that starts at the earliest deadline.
    const first = Math.min(...raw.map((r) => r.s));
    const slots = raw
      .map((r) => ({ ...r, s: r.s - Math.floor((r.s - first) / WEEK) * WEEK }))
      .sort((a, b) => a.s - b.s);
    slots.forEach((slot, i) => {
      const nextStart =
        i + 1 < slots.length ? slots[i + 1].s : slots[0].s + WEEK;
      if (slot.s + slot.gapMs > nextStart) {
        throw new JobError(400, "slots_overlap", {
          slot: slot.input,
          other: (i + 1 < slots.length ? slots[i + 1] : slots[0]).input,
        });
      }
    });
    return {
      classId,
      slots: slots.map(({ s, gapMs }) => {
        const sp = vnParts(s);
        const gp = vnParts(s + gapMs);
        return {
          anchorStudentAt: s,
          gapMs,
          studentDeadline: { weekday: sp.weekday, time: sp.time },
          graderDeadline: { weekday: gp.weekday, time: gp.time },
        };
      }),
    };
  }

  /** Side-effect free: what saving these deadlines would schedule. */
  async function preview({ viewer, classId, ...deadlines }) {
    const cls = await loadManagedClass(viewer, classId);
    // Reads only. Like upsert: after the last graded occurrence is over — a
    // reminded one that saving would forget does not count.
    const sSnap = await scheduleRef(cls.id).get();
    const old = sSnap.exists ? sSnap.data() : null;
    const def = {
      ...define(cls.id, slotInput(deadlines)),
      ...runTimeFields(old?.customRunTimes, await readDefaultRunTimes()),
    };
    let bound = -Infinity;
    if (old?.lastRunKey) {
      const last = (await runRef(cls.id, old.lastRunKey).get()).data();
      const forgotten =
        last?.state === "reminded" && old.next?.runKey === old.lastRunKey;
      if (last && !forgotten) bound = last.graderDeadlineAt;
    }
    // The week saving would forget (see upsert's oldRunForgotten).
    let forgottenKey = null;
    if (old?.next?.runKey) {
      const run = (await runRef(cls.id, old.next.runKey).get()).data();
      const jobGone = !run?.jobId || !(await jobDocRef(run.jobId).get()).exists;
      if (run?.state === "reminded" || (run?.state === "starting" && jobGone)) {
        forgottenKey = old.next.runKey;
      }
    }
    // Same candidates and the same placement as upsert, so the preview never
    // promises a day that saving then moves.
    const first = firstReachable(def, 0, now(), opts);
    const candidates = Array.from(
      { length: 2 * def.slots.length + 2 },
      (_, k) => occurrence(def, first.index + k, opts),
    );
    const runSnaps = await db.getAll(
      ...candidates.map((c) => runRef(cls.id, c.runKey)),
    );
    let occ = null;
    let replaces = null;
    let takenRunKey = null;
    for (let i = 0; i < candidates.length && !occ; i++) {
      const c = candidates[i];
      if (c.studentDeadlineAt < bound) continue;
      const place = await placeCandidate(
        (ref) => ref.get(),
        cls.id,
        c,
        runSnaps[i],
        forgottenKey,
      );
      if (place.runKey) {
        occ = { ...c, runKey: place.runKey };
        replaces = place.replaces;
      } else {
        takenRunKey = takenRunKey || place.takenKey;
      }
    }
    occ = occ || candidates[candidates.length - 1];
    return {
      ...def,
      next: {
        ...occ,
        remindAt: remindAtOf(occ),
        // The day's earlier, finished run this one grades again after — the
        // screen says it is a re-grade, not a first grading.
        replacesRunKey: replaces,
        // A day skipped because the class is being graded that day right now.
        skippedRunKey: takenRunKey,
      },
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

  async function upsert({ viewer, classId, ...deadlines }) {
    const cls = await loadManagedClass(viewer, classId);
    if (cls.isActive === false) throw new JobError(409, "class_inactive");
    if (!cls.currentLesson) throw new JobError(409, "no_current_lesson");
    const def = define(cls.id, slotInput(deadlines));
    const email = String(viewer.email || "").toLowerCase();
    const authKind = viewer.authKind === "google" ? "google" : "jwt";
    if (authKind === "google" && !(await hasRefreshToken(email))) {
      throw new JobError(409, "google_reauth_required");
    }
    const payer = await resolvePayer(email, cls.id);
    if (!payer) throw new JobError(403, "payer_not_found");

    const saved = await db.runTransaction(async (tx) => {
      const [sSnap, settingsSnap] = await tx.getAll(
        scheduleRef(cls.id),
        settingsRef(),
      );
      const old = sSnap.exists ? sSnap.data() : null;
      // The time is the admin's: the class's own, else the default — read in
      // here so a new default cannot slip past this save (setDefaultRunTime).
      const timed = {
        ...def,
        ...runTimeFields(old?.customRunTimes, defaultRunTimesOf(settingsSnap)),
      };
      // Candidate first occurrences, in order (two weeks of slots and then
      // some); the first free one wins — see below.
      const first = firstReachable(timed, 0, now(), opts);
      const candidates = Array.from(
        { length: 2 * timed.slots.length + 2 },
        (_, k) => occurrence(timed, first.index + k, opts),
      );
      const oldRunSnap = old?.next?.runKey
        ? await tx.get(runRef(cls.id, old.next.runKey))
        : null;
      const oldRun = oldRunSnap?.exists ? oldRunSnap.data() : null;
      const oldJob = oldRun?.jobId
        ? await tx.get(jobDocRef(oldRun.jobId))
        : null;
      const oldRunForgotten =
        oldRun &&
        (oldRun.state === "reminded" ||
          (oldRun.state === "starting" && !oldJob?.exists));
      // The last occurrence that actually happened (its run stays).
      const lastKey = old?.lastRunKey;
      const lastRunSnap =
        lastKey && !(oldRunForgotten && lastKey === oldRun.runKey)
          ? await tx.get(runRef(cls.id, lastKey))
          : null;
      const lastRun = lastRunSnap?.exists ? lastRunSnap.data() : null;
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
      // The first candidate that can take the week (placeCandidate: a new
      // day, the week we are about to forget, or a re-grade of a day whose
      // run is over), and not before the last graded occurrence was over —
      // moving tonight's deadline by an hour after tonight's grading must
      // not grade the class again tonight, on the lesson it has just moved
      // on to. Reads, so before any write.
      let occ = null;
      for (let i = 0; i < candidates.length && !occ; i++) {
        const c = candidates[i];
        if (lastRun && c.studentDeadlineAt < lastRun.graderDeadlineAt) {
          continue;
        }
        const place = await placeCandidate(
          (ref) => tx.get(ref),
          cls.id,
          c,
          candidateSnaps[i],
          oldRunForgotten ? oldRun.runKey : null,
        );
        if (place.runKey) occ = { ...c, runKey: place.runKey };
      }
      occ = occ || candidates[candidates.length - 1];
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
      const at = now();
      const doc = {
        ...timed,
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

  /**
   * A slot as the website shows it: its grading day (`anchorDayAt`, the
   * first one) — for a legacy slot the day its first week is graded on —
   * plus a legacy slot's deadlines.
   */
  function clientSlot(s, slot, index) {
    if (Number.isFinite(slot.anchorDayAt)) {
      return {
        kind: "day",
        anchorDayAt: slot.anchorDayAt,
        part: partOf(slot),
        weekday: vnParts(slot.anchorDayAt).weekday,
      };
    }
    // The part of the day its grading falls in; after midnight (before the
    // morning's hours) counts as the evening before.
    const runAt = occurrence(s, index, opts).runAt;
    let dayAt = vnDayStart(runAt);
    const minutes = (runAt - dayAt) / MINUTE;
    let part = Object.keys(PARTS).find(
      (p) => minutes >= PARTS[p].from && minutes < PARTS[p].to,
    );
    if (!part) {
      part = "evening";
      dayAt -= DAY;
    }
    const sp = vnParts(slot.anchorStudentAt);
    const gp = vnParts(slot.anchorStudentAt + slot.gapMs);
    return {
      kind: "deadlines",
      anchorDayAt: dayAt,
      part,
      weekday: vnParts(dayAt).weekday,
      anchorStudentAt: slot.anchorStudentAt,
      gapMs: slot.gapMs,
      studentDeadline: { weekday: sp.weekday, time: sp.time },
      graderDeadline: { weekday: gp.weekday, time: gp.time },
    };
  }

  function toClient(s, lastRun) {
    if (!s) return null;
    const days = isDaySchedule(s);
    return {
      classId: s.classId,
      className: s.className,
      enabled: Boolean(s.enabled),
      slots: slotsOf(s).map((slot, i) => clientSlot(s, slot, i)),
      // The grading times of a day schedule; a legacy one has none.
      ...(days
        ? runTimeFields(s.customRunTimes, {
            ...opts.runTimes,
            ...cleanRunTimes(s.runTimes),
          })
        : { runTimes: null, customRunTimes: {} }),
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

  // -------------------------------------------------------------------------
  // admin: the grading times of the parts of the day
  // -------------------------------------------------------------------------

  const hhmm = (minutes) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

  /**
   * {runTimes, parts}: the default time of each part of the day ("HH:mm",
   * Vietnam), and the hours each part's time must stay within.
   */
  async function getSettings() {
    return {
      runTimes: await readDefaultRunTimes(),
      parts: Object.fromEntries(
        Object.entries(PARTS).map(([part, { from, to }]) => [
          part,
          { from: hhmm(from), to: hhmm(to) },
        ]),
      ),
    };
  }

  /**
   * Gives a day schedule new times — `ownFor(schedule)` is the class's own
   * times to keep, null for no change — in one transaction. A week not
   * reminded yet is planned again at the new time, from the same week on; one
   * already reminded keeps its time, and the change applies from the next.
   * Returns whether the schedule changed.
   */
  function retime(classId, ownFor) {
    return db.runTransaction(async (tx) => {
      const [sSnap, settingsSnap] = await tx.getAll(
        scheduleRef(classId),
        settingsRef(),
      );
      if (!sSnap.exists || !isDaySchedule(sSnap.data())) return false;
      const s = sSnap.data();
      const own = ownFor(s);
      if (!own) return false;
      const fields = runTimeFields(own, defaultRunTimesOf(settingsSnap));
      const same = (a, b) =>
        Object.keys(PARTS).every((part) => (a || {})[part] === (b || {})[part]);
      if (
        same(fields.runTimes, s.runTimes) &&
        same(fields.customRunTimes, s.customRunTimes)
      ) {
        return false;
      }
      const runSnap = s.next?.runKey
        ? await tx.get(runRef(classId, s.next.runKey))
        : null;
      // ---- no writes above this line ----
      const patch = { ...fields, updatedAt: now() };
      if (s.enabled && s.nextStep === "remind" && s.next && !runSnap?.exists) {
        Object.assign(patch, advanceFields({ ...s, ...fields }, s.next.index));
      }
      tx.update(sSnap.ref, patch);
      return true;
    });
  }

  /**
   * {part: "HH:mm" | null | ""} checked against each part's hours: the
   * given times, and the parts given empty (null, "").
   */
  function checkRunTimes(input) {
    if (!input || typeof input !== "object") {
      throw new JobError(400, "invalid_run_time");
    }
    const times = {};
    const cleared = [];
    for (const [part, value] of Object.entries(input)) {
      if (!PARTS[part]) throw new JobError(400, "invalid_part");
      if (value === null || value === "") {
        cleared.push(part);
        continue;
      }
      const time = partTime(part, value);
      if (!time) {
        const { from, to } = PARTS[part];
        throw new JobError(400, "invalid_run_time", {
          part,
          from: hhmm(from),
          to: hhmm(to),
        });
      }
      times[part] = time;
    }
    return { times, cleared };
  }

  /**
   * An admin sets one class's own times: `runTimes` {part: "HH:mm"}, a part
   * left out or empty runs on the default. Only for a schedule of grading
   * days.
   */
  async function setClassRunTimes({ viewer, classId, runTimes }) {
    if (!viewer.isAdmin) throw new JobError(403, "admin_only");
    const cls = await loadManagedClass(viewer, classId);
    const { times } = checkRunTimes(runTimes);
    const snap = await scheduleRef(cls.id).get();
    if (!snap.exists) throw new JobError(404, "schedule_not_found");
    if (!isDaySchedule(snap.data())) {
      throw new JobError(409, "schedule_needs_days");
    }
    await retime(cls.id, () => times);
    return get({ viewer, classId: cls.id });
  }

  /**
   * An admin sets the default time of some parts of the day; every day
   * schedule follows it for the parts it has no time of its own for (see
   * retime). `classes`: how many moved.
   */
  async function setDefaultRunTimes({ viewer, runTimes }) {
    if (!viewer.isAdmin) throw new JobError(403, "admin_only");
    const { times, cleared } = checkRunTimes(runTimes);
    const stored = cleanRunTimes((await settingsRef().get()).data()?.runTimes);
    for (const part of cleared) delete stored[part];
    const next = { ...stored, ...times };
    await settingsRef().set({
      runTimes: next,
      updatedAt: now(),
      updatedByEmail: String(viewer.email || "").toLowerCase(),
    });
    const snap = await db
      .collection(SCHEDULES)
      .where("enabled", "==", true)
      .get();
    let classes = 0;
    for (const doc of snap.docs) {
      if (!isDaySchedule(doc.data())) continue;
      if (await retime(doc.id, (s) => cleanRunTimes(s.customRunTimes))) {
        classes += 1;
      }
    }
    const runTimesNow = { ...opts.runTimes, ...next };
    info(
      `default grading times ${JSON.stringify(runTimesNow)}: ${classes} class(es) moved`,
    );
    return { runTimes: runTimesNow, classes };
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
      balanceVnd: pointSnap.exists ? balanceVndOf(pointSnap.data()) : 0,
      priceVnd: PRICE_AUTO_VND,
      needMax: classes.reduce((sum, c) => sum + c.students, 0),
      needMaxVnd:
        classes.reduce((sum, c) => sum + c.students, 0) * PRICE_AUTO_VND,
      classes,
    };
  }

  return {
    disable,
    getSettings,
    estimate,
    get,
    handleTask,
    listFor,
    onJobFinished,
    preview,
    tick,
    upsert,
    setClassRunTimes,
    setDefaultRunTimes,
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
  runKeyOf,
  slotsOf,
  occurrence,
  offPeakSegments,
  parseOffPeak,
  parseRunTime,
  parseVnDate,
  pickRunAt,
  render,
  scheduledJobId,
  vnDayStart,
  vnParts,
};
