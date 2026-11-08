/**
 * Grading a KTN session on the SEC LMS — the LMS twin of lib/gradingJobs.js,
 * kept separate so the Google Doc flow is untouched. It shares the grader
 * (gradeItemsCached: same Basic prompt, same cache), the doc helpers it only
 * imports (isCorrectFeedback, generateOverallFeedback, formatFeedbackForDoc,
 * makeAnswerKey) and the per-receipt billing (consumePointsForDocs).
 *
 * Two phases, both Cloud Tasks steps (lib/taskQueue.js, payload kind "lms"):
 *
 *   prepare  Reads every submission of the session, grades the writing
 *            assignment ("BÀI TẬP VIẾT CÂU") and stores the verdicts. Nothing
 *            is written to the LMS. The job is then "graded": the teacher
 *            reviews it on our site.
 *   write    One task per student the teacher selected ("Lưu nháp lên LMS").
 *            Re-reads the student's page and only then saves a DRAFT — never
 *            a submission. Charged per student, once, after the draft landed.
 *
 * Safety rules (plan R4–R6):
 *   - a student whose writing assignment is not fully submitted, already
 *     graded by the teacher (2/3), or carries reviews we did not write is
 *     skipped with a reason — the tool never overwrites part of a grading;
 *   - before saving, the answers must hash to what was graded (else
 *     "changed") and the reviews must be the ones we saw at grading time
 *     (else "teacher_modified"); reviews equal to OUR draft mean an earlier
 *     attempt already landed: no second PUT, just the charge;
 *   - a later job recognises our own earlier draft (lmsDrafts) and shows the
 *     student as draft_saved instead of grading them again.
 *
 * Collections:
 *   lmsGradingJobs/{jobId}               the job (+ students/{studentId})
 *   lmsGradingJobLocks/{classId}_{sessionId}   one active job per session
 *   lmsDrafts/{classId}_{sessionId}_{studentId} the last draft we saved
 */
const crypto = require("crypto");

const { LmsError, lmsGradingPageUrl } = require("./lms/lmsClient.js");
const { LmsReloginRequired } = require("./lms/lmsAccounts.js");
const L = require("./lms/lmsItems.js");
const V = require("./lms/lmsView.js");
const { JobError, RetryLater } = require("./gradingJobs.js");

const JOBS = "lmsGradingJobs";
const LOCKS = "lmsGradingJobLocks";
const DRAFTS = "lmsDrafts";

/** Same staleness rule as gradingJobs (task deadline + queue retry window). */
const JOB_STALE_MS = 2 * 60 * 60 * 1000;
const PREPARE_LEASE_MS = 35 * 60 * 1000;
const PREPARE_DEADLINE_SECONDS = 30 * 60;
const MAX_PREPARE_ATTEMPTS = 5;
const MAX_WRITE_ATTEMPTS = 5;
const READ_CONCURRENCY = 5;
/** Job data (answers, reviews) is deleted by a Firestore TTL policy after… */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** KTN only in this version. */
const COURSE_CODE = "KTN";

/**
 * Version of the grading itself (prompts, inputs). A draft saved by an older
 * one is still recognised as ours (never "teacher started"), but its reviews
 * are graded again instead of reused. Bump when a fix changes verdicts:
 *   2 — tense abbreviations spelled out in [CHỦ ĐIỂM] (HTHTTD …)
 */
const GRADER_VERSION = 2;

/** Student states (plan R5). */
const S = Object.freeze({
  GRADED: "graded",
  WRITE_QUEUED: "write_queued",
  DRAFT_SAVED: "draft_saved",
  CHANGED: "changed",
  TEACHER_MODIFIED: "teacher_modified",
  TEACHER_GRADED: "teacher_graded",
  SKIPPED: "skipped",
  WRITE_FAILED: "write_failed",
  INSUFFICIENT: "insufficient_points",
});
/** States a student may be (re)selected for "Lưu nháp" from. */
const WRITABLE = new Set([S.GRADED, S.WRITE_FAILED, S.INSUFFICIENT]);
const BUSY = new Set(["queued", "preparing", "writing"]);

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

const info = (...args) => console.log("[LMS-JOB]", ...args); // eslint-disable-line no-console

/** Score-report entries of the assignments the tool grades. */
function targetReports(row) {
  return (row?.scoreReportList || []).filter((r) =>
    L.isTargetAssignment({ name: r.assignmentName }),
  );
}

const isSubmitted = (r) =>
  r.gradingStatus !== null && r.gradingStatus !== undefined;
const isTeacherDone = (status) =>
  status === L.GRADING_STATUS.COMPLETED || status === L.GRADING_STATUS.LATE;

/** Ids (strings) of the graded-kind assignments the student submitted. */
function submittedIdsOf(row) {
  return new Set(
    targetReports(row)
      .filter(isSubmitted)
      .map((r) => String(r.assignmentId)),
  );
}

/**
 * Where a student stands from the session's score report alone (no page
 * read): notSubmitted / teacherGraded / candidate. Only the assignments the
 * student submitted count; the others are simply not graded.
 */
function triage(row) {
  const reports = targetReports(row);
  if (!reports.length) return "noWritingAssignment";
  const submitted = reports.filter(isSubmitted);
  if (!submitted.length) return "notSubmitted";
  if (submitted.some((r) => isTeacherDone(r.gradingStatus))) {
    return "teacherGraded";
  }
  return "candidate";
}

/** Same rule on a freshly read page, for the assignments we write. */
function pageTeacherGraded(grading, assignmentIds) {
  const ids = new Set(assignmentIds.map(String));
  return grading.some(
    (a) => ids.has(String(a.assignmentId)) && isTeacherDone(a.gradingStatus),
  );
}

function logIdsOf(grading, assignmentIds) {
  const ids = new Set(assignmentIds.map(String));
  return grading
    .filter((a) => ids.has(String(a.assignmentId)))
    .map((a) => `${a.assignmentId}:${a.assignmentLogId ?? ""}`)
    .sort()
    .join(",");
}

/**
 * What we saved earlier for one assignment, from an lmsDrafts record. The
 * first version recorded one hash pair for the writing assignment only
 * ({draftHash, answerHash}); it is read as that assignment's record.
 */
function ownDraftOf(draft, target) {
  if (!draft) return null;
  const rec = draft.assignments?.[String(target.assignmentId)];
  if (rec) return rec;
  if (!draft.assignments && target.kind === L.KIND.WRITING && draft.draftHash) {
    return { reviewHash: draft.draftHash, answerHash: draft.answerHash };
  }
  return null;
}

/**
 * @param deps.db, deps.admin
 * @param deps.lmsClient      createLmsClient(...)
 * @param deps.lmsAccounts    createLmsAccounts(...)
 * @param deps.loadDocLib     () => Promise<lib/doc exports>
 * @param deps.gradeItems     gradeItemsCached
 * @param deps.consumePoints  consumePointsForDocs bound to (db, admin)
 * @param deps.readBalanceVnd (teacherId) => Promise<number>
 * @param deps.enqueue        (name, payload, opts) => Promise
 * @param deps.writeEnabled   () => boolean (LMS_WRITE_ENABLED kill switch)
 * @param deps.draftOptions   {onlyTargets, shareOverall} for buildDraftPayload
 * @param deps.hooks          { onPrepared(job), onRoundFinished(job, round),
 *                              onDraftSaved(job, student) } — best effort
 * @param deps.now            () => ms
 */
function createLmsGradingJobs(deps) {
  const {
    db,
    lmsClient,
    lmsAccounts,
    loadDocLib,
    gradeItems,
    // (items [{kind, question, answer, context}]) => feedback[] — word order
    // and spelling (lib/lms/lmsExtraGrader.js).
    gradeExtra = async (items) => items.map(() => null),
    consumePoints,
    readBalanceVnd,
    enqueue,
    writeEnabled = () => false,
    draftOptions = {},
    hooks = {},
    now = Date.now,
  } = deps;

  const jobRef = (id) => db.collection(JOBS).doc(id);
  const studentRef = (jobId, studentId) =>
    jobRef(jobId).collection("students").doc(String(studentId));
  const lockRef = (classId, sessionId) =>
    db.collection(LOCKS).doc(`${classId}_${sessionId}`);
  const draftRef = (classId, sessionId, studentId) =>
    db.collection(DRAFTS).doc(`${classId}_${sessionId}_${studentId}`);
  const apiFor = (teacherId) =>
    lmsClient.forTeacher(lmsAccounts.tokenSource(teacherId));
  const isStale = (job) => now() - (job.progressAt || 0) > JOB_STALE_MS;
  const callHook = (name, ...args) =>
    Promise.resolve()
      .then(() => hooks[name]?.(...args))
      .catch((err) => console.error(`[LMS-JOB] hook ${name}:`, err.message));

  // ---------------------------------------------------------------------------
  // Classes and sessions the teacher may grade
  // ---------------------------------------------------------------------------

  async function listClasses(teacherId) {
    const classes = await apiFor(teacherId).listClasses();
    return classes
      .filter((c) => String(c.courseCode || "").toUpperCase() === COURSE_CODE)
      .map((c) => ({
        id: c.id,
        code: c.code,
        courseName: c.courseName,
        sessionQuantity: c.sessionQuantity ?? null,
        scheduleName: c.scheduleName || "",
      }));
  }

  /** Verifies the class is one of the teacher's KTN classes. */
  async function requireClass(teacherId, classId) {
    const classes = await listClasses(teacherId);
    const found = classes.find((c) => String(c.id) === String(classId));
    if (!found) throw new JobError(404, "lms_class_not_found");
    return found;
  }

  async function listSessions(teacherId, classId) {
    await requireClass(teacherId, classId);
    const sessions = await apiFor(teacherId).listSessions(classId);
    return sessions.map((s) => ({
      id: s.id,
      name: s.sessionName,
      startTime: s.startTime,
      submitDeadline: s.submitDeadline,
      checkDeadline: s.checkDeadline,
      started: s.startTime ? new Date(s.startTime).getTime() <= now() : false,
    }));
  }

  async function requireSession(teacherId, classId, sessionId) {
    const sessions = await listSessions(teacherId, classId);
    const found = sessions.find((s) => String(s.id) === String(sessionId));
    if (!found) throw new JobError(404, "lms_session_not_found");
    return found;
  }

  /** Counts from the session's score report — no page is read. */
  async function preview(teacherId, classId, sessionId, unitPriceVnd) {
    await requireSession(teacherId, classId, sessionId);
    const rows = await apiFor(teacherId).listSubmissions(classId, sessionId);
    const counts = {
      total: rows.length,
      candidate: 0,
      notSubmitted: 0,
      partial: 0,
      teacherGraded: 0,
      noWritingAssignment: 0,
    };
    for (const row of rows) counts[triage(row)] += 1;
    return {
      counts,
      unitPriceVnd,
      estimatedVnd: counts.candidate * unitPriceVnd,
    };
  }

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  /**
   * @param p.teacher   {id, name, gmail} — the caller, who also pays
   * @param p.email     caller email (audit, notifications)
   */
  async function createJob({
    teacher,
    email,
    classId,
    sessionId,
    unitPriceVnd,
  }) {
    if (!teacher?.id) throw new JobError(403, "teacher_not_found");
    const account = await lmsAccounts.status(teacher.id);
    if (!account.linked) throw new JobError(409, "lms_not_linked");
    if (account.status !== "ok")
      throw new JobError(409, "lms_relogin_required");
    const cls = await requireClass(teacher.id, classId);
    const session = await requireSession(teacher.id, classId, sessionId);
    if (!session.started) throw new JobError(409, "lms_session_not_started");

    const jobId = crypto.randomUUID();
    const at = now();
    const job = {
      id: jobId,
      kind: "lms",
      status: "queued",
      teacherId: teacher.id,
      createdByEmail: email,
      payerTeacherId: teacher.id,
      payerName: teacher.name || "",
      payerGmail: teacher.gmail || email,
      lmsClassId: String(classId),
      classCode: cls.code,
      sessionId: String(sessionId),
      sessionName: session.name || "",
      checkDeadline: session.checkDeadline || null,
      // Fixed now: a price change between grading and saving never applies.
      unitPriceVnd,
      createdAt: at,
      progressAt: at,
      expireAt: new Date(at + RETENTION_MS),
      prepareEpoch: 0,
      prepareAttempts: 0,
      prepareLeaseUntil: 0,
      writeRound: 0,
      writePending: 0,
      counts: null,
      written: 0,
      charged: 0,
      chargedVnd: 0,
      error: null,
    };

    const outcome = await db.runTransaction(async (tx) => {
      const lock = lockRef(classId, sessionId);
      const lockSnap = await tx.get(lock);
      let previous = null;
      if (lockSnap.exists && lockSnap.data().jobId) {
        const prevSnap = await tx.get(jobRef(lockSnap.data().jobId));
        if (prevSnap.exists) previous = prevSnap;
      }
      if (previous) {
        const prev = previous.data();
        if (BUSY.has(prev.status) && !isStale(prev)) {
          return { conflict: previous.id };
        }
        if (prev.status !== "failed" && prev.status !== "superseded") {
          // A finished or abandoned job: its results may no longer be saved.
          tx.update(previous.ref, {
            status: "superseded",
            supersededBy: jobId,
            progressAt: at,
          });
        }
      }
      tx.set(jobRef(jobId), job);
      tx.set(lock, {
        jobId,
        teacherId: teacher.id,
        classId: String(classId),
        sessionId: String(sessionId),
        createdAt: at,
        expiresAt: at + JOB_STALE_MS,
      });
      return { conflict: null };
    });
    if (outcome.conflict) {
      throw new JobError(409, "job_in_progress", { jobId: outcome.conflict });
    }
    try {
      await enqueue(
        `lms-prepare-${jobId}`,
        { kind: "lms", step: "prepare", jobId },
        { dispatchDeadlineSeconds: PREPARE_DEADLINE_SECONDS },
      );
    } catch (err) {
      await jobRef(jobId).update({
        status: "failed",
        error: "enqueue_failed",
        progressAt: now(),
      });
      console.error("[LMS-JOB] enqueue prepare failed:", err.message);
      throw new JobError(503, "enqueue_failed");
    }
    return { jobId };
  }

  // ---------------------------------------------------------------------------
  // prepare
  // ---------------------------------------------------------------------------

  async function claimPrepare(jobId) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return { skip: "missing" };
      const job = snap.data();
      const leaseFree =
        job.status === "queued" ||
        (job.status === "preparing" && job.prepareLeaseUntil <= now());
      if (job.status === "preparing" && !leaseFree) return { busy: true };
      if (!leaseFree) return { skip: job.status };
      if ((job.prepareAttempts || 0) >= MAX_PREPARE_ATTEMPTS) {
        tx.update(snap.ref, {
          status: "failed",
          error: "prepare_failed",
          progressAt: now(),
        });
        return { skip: "failed" };
      }
      const epoch = (job.prepareEpoch || 0) + 1;
      tx.update(snap.ref, {
        status: "preparing",
        prepareEpoch: epoch,
        prepareAttempts: (job.prepareAttempts || 0) + 1,
        prepareLeaseUntil: now() + PREPARE_LEASE_MS,
        progressAt: now(),
      });
      return { job: { ...job, status: "preparing" }, epoch };
    });
  }

  async function failJob(jobId, error, epoch = null) {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return;
      const job = snap.data();
      if (epoch !== null && job.prepareEpoch !== epoch) return;
      if (job.status !== "preparing" && job.status !== "queued") return;
      tx.update(snap.ref, { status: "failed", error, progressAt: now() });
    });
  }

  /** One student's row before grading, from the score report + their page. */
  async function readStudent(api, job, row) {
    const base = {
      studentId: String(row.studentId),
      fullName: row.fullName || "",
      expireAt: new Date(job.createdAt + RETENTION_MS),
    };
    const state = triage(row);
    if (state === "teacherGraded") return { ...base, status: S.TEACHER_GRADED };
    if (state !== "candidate") {
      return { ...base, status: S.SKIPPED, reason: state };
    }
    let grading;
    try {
      grading = await api.getGrading(
        job.lmsClassId,
        job.sessionId,
        row.studentId,
      );
    } catch (err) {
      // One unreadable page skips that student, not the whole class. A lost
      // login is the whole class's problem, so it still propagates.
      if (err instanceof LmsError) {
        return { ...base, status: S.SKIPPED, reason: "readFailed" };
      }
      throw err;
    }
    const items = L.itemsFromGrading(grading, {
      submittedIds: submittedIdsOf(row),
    });
    const assignmentIds = items.targets.map((t) => String(t.assignmentId));
    if (pageTeacherGraded(grading, assignmentIds)) {
      return { ...base, status: S.TEACHER_GRADED };
    }
    const written = items.questions.filter(L.isWritten);
    const writtenKeys = written.map((q) => q.key);
    const common = {
      ...base,
      counts: items.counts,
      assignmentIds,
      answerHash: L.hashAnswers(grading, assignmentIds),
      origReviewHash: L.hashReviews(grading, writtenKeys),
      assignmentLogIds: logIdsOf(grading, assignmentIds),
      writtenKeys,
    };
    // Blank questions are skipped, so only answered ones make a score.
    if (!written.some((q) => q.cls === L.QUESTION_CLASS.SUPPORTED)) {
      return { ...common, status: S.SKIPPED, reason: "nothingToGrade" };
    }

    // Per assignment: fresh (no reviews yet), ours (the draft we saved, the
    // answers unchanged — reused as is), or touched by someone else.
    let draft;
    const ownDrafts = new Set();
    for (const target of items.targets) {
      const id = String(target.assignmentId);
      const keys = written.filter((q) => String(q.assignmentId) === id);
      if (!keys.some((q) => q.existingReview)) continue; // fresh
      if (draft === undefined) {
        const snap = await draftRef(
          job.lmsClassId,
          job.sessionId,
          row.studentId,
        ).get();
        draft = snap.exists ? snap.data() : null;
      }
      const rec = ownDraftOf(draft, target);
      const reviewHash = L.hashReviews(
        grading,
        keys.map((q) => q.key),
      );
      if (!rec || rec.reviewHash !== reviewHash) {
        return { ...common, status: S.SKIPPED, reason: "teacherStarted" };
      }
      // Ours. Unchanged answers, same grader: keep our reviews. Changed
      // answers or an older grader: grade it again (our old reviews are what
      // gets replaced — R6 accepts them).
      if (
        rec.answerHash === L.hashAnswers(grading, [id]) &&
        (draft?.graderVersion ?? 1) === GRADER_VERSION
      ) {
        ownDrafts.add(id);
      }
    }
    // A draft from the first version wrote "Chưa làm" on blank questions and
    // counted them wrong: its reviews are reused, but the blanks are cleared
    // and the score worked out again, so it is offered for saving again.
    const legacyBlanks = written.some(
      (q) =>
        q.cls === L.QUESTION_CLASS.BLANK &&
        ownDrafts.has(String(q.assignmentId)) &&
        q.existingReview === L.BLANK_REVIEW,
    );
    if (ownDrafts.size === assignmentIds.length && !legacyBlanks) {
      return {
        ...common,
        status: S.DRAFT_SAVED,
        previousJobId: draft?.jobId || null,
      };
    }
    return { ...common, grading, items, ownDrafts };
  }

  async function prepare(jobId) {
    const claim = await claimPrepare(jobId);
    if (claim.busy) throw new RetryLater("prepare_leased");
    if (!claim.job) return;
    const { job, epoch } = claim;
    try {
      await runPrepare(jobId, job, epoch);
    } catch (err) {
      if (err instanceof LmsReloginRequired) {
        await failJob(jobId, "lms_relogin_required", epoch);
        return;
      }
      if (err instanceof JobError && err.status < 500) {
        await failJob(jobId, err.code, epoch);
        return;
      }
      // Free the lease so the queue's retry can take the job over at once.
      await db
        .runTransaction(async (tx) => {
          const snap = await tx.get(jobRef(jobId));
          if (snap.exists && snap.data().prepareEpoch === epoch) {
            tx.update(snap.ref, { prepareLeaseUntil: 0 });
          }
        })
        .catch(() => {});
      throw err;
    }
  }

  async function runPrepare(jobId, job, epoch) {
    const lib = await loadDocLib();
    const api = apiFor(job.teacherId);
    const rows = await api.listSubmissions(job.lmsClassId, job.sessionId);
    const students = await mapLimit(rows, READ_CONCURRENCY, (row) =>
      readStudent(api, job, row),
    );
    const toGrade = students.filter((s) => s.items);

    // Only students we will grade must be affordable — like the doc flow.
    if (toGrade.length) {
      const balance = await readBalanceVnd(job.payerTeacherId);
      const need = toGrade.length * job.unitPriceVnd;
      if (balance < need) {
        await failJob(jobId, "not_enough_points", epoch);
        await jobRef(jobId).update({
          errorParams: {
            need: toGrade.length,
            needVnd: need,
            haveVnd: balance,
          },
        });
        return;
      }
    }

    // What each supported question needs: reuse of our own draft, the Basic
    // grader (writing) or the extra grader (word order, spelling).
    const fromDraft = (s, q) => s.ownDrafts.has(String(q.assignmentId));
    const needsGrading = (s, q) =>
      q.cls === L.QUESTION_CLASS.SUPPORTED && !fromDraft(s, q);

    // Dedupe across the class: identical answers are graded once (and hit
    // the same gradingCache records as the doc flow).
    const unique = new Map();
    const keyOf = (q) =>
      lib.makeAnswerKey(q.question, q.answer, q.taskType, q.section);
    for (const s of toGrade) {
      for (const q of s.items.questions) {
        if (!needsGrading(s, q) || q.kind !== L.KIND.WRITING) continue;
        const key = keyOf(q);
        if (!unique.has(key)) {
          unique.set(key, {
            question: q.question,
            answer: q.answer,
            taskType: q.taskType,
            ...(q.section ? { section: q.section } : {}),
          });
        }
      }
    }
    const feedbackByAnswer = new Map();
    if (unique.size) {
      const graded = await gradeItems([...unique.values()], {
        useCache: true,
        requestId: jobId,
      });
      for (const g of graded || []) {
        if (g && g.feedback !== null && g.feedback !== undefined) {
          feedbackByAnswer.set(
            lib.makeAnswerKey(g.question, g.answer, g.taskType, g.section),
            lib.formatFeedbackForDoc(g.feedback),
          );
        }
      }
    }

    // Word order and spelling: one call for the whole class (deduped and
    // cached inside the extra grader).
    const extraQuestions = [];
    for (const s of toGrade) {
      for (const q of s.items.questions) {
        if (needsGrading(s, q) && q.kind !== L.KIND.WRITING) {
          extraQuestions.push({ s, q });
        }
      }
    }
    const extraFeedback = new Map(); // `${studentId}|${key}` -> feedback
    if (extraQuestions.length) {
      const feedbacks = await gradeExtra(
        extraQuestions.map(({ q }) => ({
          kind: q.kind,
          question: q.question,
          answer: q.answer,
          context: q.context,
        })),
      );
      extraQuestions.forEach(({ s, q }, i) => {
        if (feedbacks[i])
          extraFeedback.set(`${s.studentId}|${q.key}`, feedbacks[i]);
      });
    }

    const rowsToWrite = students.map((s) => {
      if (!s.items) {
        const { grading, items, ...rest } = s;
        return rest;
      }
      const feedbackByKey = new Map();
      for (const q of s.items.questions) {
        if (q.cls !== L.QUESTION_CLASS.SUPPORTED) continue;
        const fb = fromDraft(s, q)
          ? q.existingReviewMarked // our own earlier review, bold kept
          : q.kind === L.KIND.WRITING
            ? feedbackByAnswer.get(keyOf(q))
            : extraFeedback.get(`${s.studentId}|${q.key}`);
        if (fb !== undefined && fb !== null && fb !== "") {
          feedbackByKey.set(q.key, fb);
        }
      }
      const result = L.verdictsOf(s.items.questions, feedbackByKey, lib);
      const { grading, items, ownDrafts, ...rest } = s;
      if (result.error) {
        return { ...rest, status: S.SKIPPED, reason: "noFeedback" };
      }
      result.assignmentIds = s.assignmentIds;
      return {
        ...rest,
        status: S.GRADED,
        // Assignments whose reviews are our own earlier draft (re-sent as
        // they are, with the session's new score).
        reusedAssignmentIds: [...ownDrafts],
        score: result.score,
        correct: result.correct,
        counted: result.counted,
        overall: result.overall,
        draftHash: L.hashDraft(grading, result),
        questions: items.questions.map((q) => {
          const v = result.verdicts.get(q.key);
          return {
            key: q.key,
            assignmentId: q.assignmentId,
            assignmentName: q.assignmentName,
            kind: q.kind,
            serialNumber: q.serialNumber,
            cls: q.cls,
            ...(q.reason ? { reason: q.reason } : {}),
            section: q.section,
            question: q.question,
            answer: q.answer,
            ...(v ? { review: v.review, isCorrect: v.isCorrect } : {}),
            ...(v?.blank ? { blank: true } : {}),
            ...(v && !v.blank && ownDrafts.has(String(q.assignmentId))
              ? { reused: true }
              : {}),
          };
        }),
      };
    });

    const counts = {};
    for (const s of rowsToWrite) {
      const k = s.status === S.SKIPPED ? `skipped_${s.reason}` : s.status;
      counts[k] = (counts[k] || 0) + 1;
    }

    const committed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return false;
      const current = snap.data();
      if (current.prepareEpoch !== epoch || current.status !== "preparing") {
        return false; // fenced off: a newer worker owns the job
      }
      for (const s of rowsToWrite) tx.set(studentRef(jobId, s.studentId), s);
      tx.update(snap.ref, {
        status: "graded",
        counts,
        total: rowsToWrite.length,
        gradedCount: rowsToWrite.filter((s) => s.status === S.GRADED).length,
        prepareLeaseUntil: 0,
        preparedAt: now(),
        progressAt: now(),
      });
      return true;
    });
    if (committed) {
      info(`prepared ${jobId}`, JSON.stringify(counts));
      const fresh = await jobRef(jobId).get();
      await callHook("onPrepared", { ...fresh.data(), id: jobId });
    }
  }

  // ---------------------------------------------------------------------------
  // write ("Lưu nháp lên LMS")
  // ---------------------------------------------------------------------------

  async function startWrite({ jobId, email, isAdmin = false, studentIds }) {
    if (!writeEnabled()) throw new JobError(503, "lms_write_disabled");
    const ids = [...new Set((studentIds || []).map(String))];
    if (!ids.length) throw new JobError(400, "no_students_selected");
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return { error: [404, "job_not_found"] };
      const job = snap.data();
      if (!isAdmin && job.createdByEmail !== email) {
        return { error: [403, "forbidden"] };
      }
      const lockSnap = await tx.get(lockRef(job.lmsClassId, job.sessionId));
      if (job.status === "superseded" || lockSnap.data()?.jobId !== jobId) {
        return { error: [409, "job_superseded"] };
      }
      if (job.status === "writing" && !isStale(job)) {
        return { error: [409, "write_in_progress"] };
      }
      if (job.status !== "graded" && job.status !== "writing") {
        return { error: [409, "job_not_ready"] };
      }
      const snaps = await tx.getAll(...ids.map((id) => studentRef(jobId, id)));
      const eligible = snaps
        .filter((s) => s.exists && WRITABLE.has(s.data().status))
        .map((s) => s.id);
      if (!eligible.length) return { error: [409, "nothing_to_write"] };
      const round = (job.writeRound || 0) + 1;
      for (const id of eligible) {
        tx.update(studentRef(jobId, id), {
          status: S.WRITE_QUEUED,
          writeRound: round,
          writeAttempts: 0,
          reason: null,
        });
      }
      tx.update(snap.ref, {
        status: "writing",
        writeRound: round,
        writePending: eligible.length,
        roundStats: { requested: eligible.length },
        progressAt: now(),
      });
      tx.update(lockRef(job.lmsClassId, job.sessionId), {
        expiresAt: now() + JOB_STALE_MS,
      });
      return { round, eligible };
    });
    if (outcome.error) throw new JobError(outcome.error[0], outcome.error[1]);
    for (const studentId of outcome.eligible) {
      await enqueue(`lms-write-${jobId}-${studentId}-${outcome.round}`, {
        kind: "lms",
        step: "write",
        jobId,
        studentId,
        round: outcome.round,
      });
    }
    return { round: outcome.round, queued: outcome.eligible.length };
  }

  /**
   * Ends one student's write in this round: their state, the job's counters,
   * and — for the last one — the job's return to "graded".
   */
  async function finishStudent(jobId, studentId, round, update) {
    const result = await db.runTransaction(async (tx) => {
      const jobSnap = await tx.get(jobRef(jobId));
      const stSnap = await tx.get(studentRef(jobId, studentId));
      if (!jobSnap.exists || !stSnap.exists) return null;
      const st = stSnap.data();
      if (st.status !== S.WRITE_QUEUED || st.writeRound !== round) return null;
      const job = jobSnap.data();
      tx.update(stSnap.ref, { ...update, finishedAt: now() });
      const pending = Math.max(0, (job.writePending || 0) - 1);
      const stats = { ...(job.roundStats || {}) };
      stats[update.status] = (stats[update.status] || 0) + 1;
      const patch = {
        writePending: pending,
        roundStats: stats,
        progressAt: now(),
      };
      if (update.status === S.DRAFT_SAVED) {
        patch.written = (job.written || 0) + 1;
      }
      if (update.chargedVnd) {
        patch.charged = (job.charged || 0) + 1;
        patch.chargedVnd = (job.chargedVnd || 0) + update.chargedVnd;
      }
      if (pending === 0 && job.status === "writing") patch.status = "graded";
      tx.update(jobSnap.ref, patch);
      return { roundDone: pending === 0, job: { ...job, ...patch, id: jobId } };
    });
    if (result?.roundDone) {
      await callHook("onRoundFinished", result.job, round);
    }
    return result;
  }

  async function writeStudent({ jobId, studentId, round }) {
    const [jobSnap, stSnap] = await Promise.all([
      jobRef(jobId).get(),
      studentRef(jobId, studentId).get(),
    ]);
    if (!jobSnap.exists || !stSnap.exists) return;
    const job = { ...jobSnap.data(), id: jobId };
    const st = stSnap.data();
    if (st.status !== S.WRITE_QUEUED || st.writeRound !== round) return;
    const end = (status, extra = {}) =>
      finishStudent(jobId, studentId, round, { status, ...extra });

    if (job.status === "superseded") {
      return end(S.WRITE_FAILED, { reason: "superseded" });
    }
    if (!writeEnabled())
      return end(S.WRITE_FAILED, { reason: "writeDisabled" });
    if ((st.writeAttempts || 0) >= MAX_WRITE_ATTEMPTS) {
      return end(S.WRITE_FAILED, { reason: "tooManyAttempts" });
    }
    await studentRef(jobId, studentId).update({
      writeAttempts: (st.writeAttempts || 0) + 1,
    });

    const api = apiFor(job.teacherId);
    let reread;
    try {
      reread = await api.getGrading(job.lmsClassId, job.sessionId, studentId);
    } catch (err) {
      if (err instanceof LmsReloginRequired) {
        return end(S.WRITE_FAILED, { reason: "lms_relogin_required" });
      }
      throw err; // LMS down: the queue retries
    }

    const ids = st.assignmentIds || [];
    if (pageTeacherGraded(reread, ids)) return end(S.TEACHER_GRADED);
    if (
      L.hashAnswers(reread, ids) !== st.answerHash ||
      logIdsOf(reread, ids) !== st.assignmentLogIds
    ) {
      return end(S.CHANGED, { reason: "answersChanged" });
    }
    const currentReviews = L.hashReviews(reread, st.writtenKeys);
    const alreadySaved = currentReviews === st.draftHash;
    if (!alreadySaved && currentReviews !== st.origReviewHash) {
      return end(S.TEACHER_MODIFIED, { reason: "reviewsChanged" });
    }

    const docId = `lms:${job.lmsClassId}:${job.sessionId}:${studentId}`;
    let finalPage = reread;
    if (!alreadySaved) {
      const balance = await readBalanceVnd(job.payerTeacherId);
      if (balance < job.unitPriceVnd) {
        return end(S.INSUFFICIENT, { reason: "not_enough_points" });
      }
      const verdicts = new Map(
        (st.questions || [])
          .filter((q) => q.review !== undefined)
          .map((q) => [
            q.key,
            { review: q.review, isCorrect: q.isCorrect, blank: q.blank },
          ]),
      );
      const payload = L.buildDraftPayload(
        reread,
        {
          verdicts,
          score: st.score,
          overall: st.overall,
          assignmentIds: ids,
        },
        { ...draftOptions, now: now() },
      );
      try {
        await api.saveDraft(job.lmsClassId, job.sessionId, studentId, payload);
      } catch (err) {
        if (err instanceof LmsError && err.code === "write_uncertain") {
          // It may have landed. The retry re-reads and finds out (R6).
          throw new RetryLater("write_uncertain");
        }
        if (err instanceof LmsReloginRequired) {
          return end(S.WRITE_FAILED, { reason: "lms_relogin_required" });
        }
        if (err instanceof LmsError && err.status && err.status < 500) {
          return end(S.WRITE_FAILED, { reason: `lms_${err.code}` });
        }
        throw err;
      }
      const confirm = await api.getGrading(
        job.lmsClassId,
        job.sessionId,
        studentId,
      );
      if (L.hashReviews(confirm, st.writtenKeys) !== st.draftHash) {
        return end(S.WRITE_FAILED, { reason: "verifyMismatch" });
      }
      finalPage = confirm;
    }

    // Charged once per student and SESSION, after the draft is on the LMS:
    // grading a late-submitted assignment of the same session is not a new
    // charge, and a retried step settles through the same receipt.
    const charge = await consumePoints({
      payer: {
        id: job.payerTeacherId,
        name: job.payerName,
        gmail: job.payerGmail,
      },
      docIds: [docId],
      classId: `lms:${job.lmsClassId}`,
      lessonId: `lms-session:${job.sessionId}`,
      chargedByEmail: job.createdByEmail,
      unitPriceVnd: job.unitPriceVnd,
      jobId,
      chargeScope: "lms-session",
    });
    // What we left on each assignment, read back from the LMS: a later job
    // recognises it as ours (reused, never re-graded or re-charged).
    const writtenKeys = new Set(st.writtenKeys || []);
    const assignments = {};
    for (const id of ids) {
      const keys = [...writtenKeys].filter((k) => k.split(":")[0] === id);
      assignments[id] = {
        reviewHash: L.hashReviews(finalPage, keys),
        answerHash: L.hashAnswers(finalPage, [id]),
      };
    }
    await draftRef(job.lmsClassId, job.sessionId, studentId).set({
      jobId,
      assignments,
      savedAt: now(),
      teacherId: job.teacherId,
      graderVersion: GRADER_VERSION,
    });
    const unpaid = Boolean(charge?.need);
    await callHook("onDraftSaved", job, { ...st, studentId, unpaid });
    return end(S.DRAFT_SAVED, {
      writtenAt: now(),
      chargedVnd: charge?.chargedVnd || 0,
      ...(unpaid ? { unpaid: true } : {}),
      lmsUrl: lmsGradingPageUrl(job.lmsClassId, job.sessionId, studentId),
    });
  }

  // ---------------------------------------------------------------------------
  // reads
  // ---------------------------------------------------------------------------

  async function getJob(jobId, { email, isAdmin = false } = {}) {
    const snap = await jobRef(jobId).get();
    if (!snap.exists) throw new JobError(404, "job_not_found");
    const job = snap.data();
    if (!isAdmin && job.createdByEmail !== email) {
      throw new JobError(403, "forbidden");
    }
    const studentsSnap = await jobRef(jobId).collection("students").get();
    const students = studentsSnap.docs
      .map((d) => {
        const s = d.data();
        delete s.answerHash;
        delete s.origReviewHash;
        delete s.draftHash;
        delete s.assignmentLogIds;
        delete s.writtenKeys;
        return {
          ...s,
          lmsUrl: lmsGradingPageUrl(job.lmsClassId, job.sessionId, s.studentId),
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, "vi"));
    const { prepareEpoch, prepareLeaseUntil, ...visible } = job;
    return { job: { ...visible, writeEnabled: writeEnabled() }, students };
  }

  async function latestJob(classId, sessionId, viewer) {
    const lockSnap = await lockRef(classId, sessionId).get();
    const jobId = lockSnap.exists ? lockSnap.data().jobId : null;
    if (!jobId) return null;
    try {
      return await getJob(jobId, viewer);
    } catch (err) {
      if (err instanceof JobError && err.status === 403) return null;
      throw err;
    }
  }

  async function handleTask(payload) {
    if (payload?.step === "prepare") return prepare(payload.jobId);
    if (payload?.step === "write") return writeStudent(payload);
    console.error("[LMS-JOB] unknown step", payload?.step);
  }

  // ---------------------------------------------------------------------------
  // Read-only views (no grading, no writes to the LMS)
  // ---------------------------------------------------------------------------

  /**
   * Every session held so far × every student: per assignment its status and
   * score, from the sessions' score reports. A cell the tool saved a draft
   * for (still awaiting "Lưu & Chấm bài") is flagged toolDraft.
   */
  async function classOverview(teacherId, classId) {
    const cls = await requireClass(teacherId, classId);
    const sessions = (await listSessions(teacherId, classId)).filter(
      (s) => s.started,
    );
    const api = apiFor(teacherId);
    const reports = await mapLimit(sessions, READ_CONCURRENCY, (s) =>
      api.listSubmissions(classId, s.id),
    );
    const students = new Map();
    const cells = {};
    const draftKeys = [];
    sessions.forEach((s, i) => {
      const bySession = {};
      for (const raw of reports[i] || []) {
        const row = V.overviewRow(raw);
        if (!row.studentId) continue;
        if (!students.has(row.studentId)) {
          students.set(row.studentId, {
            studentId: row.studentId,
            fullName: row.fullName,
          });
        }
        bySession[row.studentId] = { assignments: row.assignments };
        const awaiting = row.assignments.some(
          (a) => a.kind && a.status === V.WORK_STATUS.SUBMITTED,
        );
        if (awaiting) draftKeys.push([String(s.id), row.studentId]);
      }
      cells[String(s.id)] = bySession;
    });
    // Our drafts, read in chunks (a class is ~30 students × ~24 sessions).
    for (let i = 0; i < draftKeys.length; i += 100) {
      const chunk = draftKeys.slice(i, i + 100);
      const snaps = await db.getAll(
        ...chunk.map(([s, st]) => draftRef(classId, s, st)),
      );
      snaps.forEach((snap, j) => {
        if (snap.exists) {
          const [s, st] = chunk[j];
          cells[s][st].toolDraft = true;
        }
      });
    }
    return {
      classInfo: cls,
      sessions: sessions.map((s) => ({
        id: s.id,
        name: s.name,
        startTime: s.startTime,
        checkDeadline: s.checkDeadline,
      })),
      students: [...students.values()].sort((a, b) =>
        a.fullName.localeCompare(b.fullName, "vi"),
      ),
      cells,
    };
  }

  /** One student's work in one session, every assignment, for reading. */
  async function studentWork(teacherId, classId, sessionId, studentId) {
    const session = await requireSession(teacherId, classId, sessionId);
    const grading = await apiFor(teacherId).getGrading(
      classId,
      sessionId,
      studentId,
    );
    const draft = await draftRef(classId, sessionId, studentId).get();
    return {
      session: { id: session.id, name: session.name },
      studentId: String(studentId),
      fullName: grading?.[0]?.fullName || "",
      toolDraft: draft.exists,
      lmsUrl: lmsGradingPageUrl(classId, sessionId, studentId),
      assignments: V.studentWork(grading),
    };
  }

  return {
    classOverview,
    createJob,
    getJob,
    handleTask,
    latestJob,
    listClasses,
    listSessions,
    preview,
    startWrite,
    studentWork,
  };
}

module.exports = {
  GRADER_VERSION,
  COURSE_CODE,
  JOB_STALE_MS,
  STUDENT_STATUS: S,
  createLmsGradingJobs,
  triage,
};
