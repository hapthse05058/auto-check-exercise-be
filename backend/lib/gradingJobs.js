/**
 * Background grading jobs: read every student's doc, grade the answers, write
 * the feedback back and charge for it — without the teacher's browser.
 *
 * This is the server-side replacement for the website's processDocs loop. The
 * doc logic itself is NOT re-implemented here: lib/doc/ is a verbatim copy of
 * the website's modules, so the tables found, answers read and text written are
 * exactly what the browser used to produce.
 *
 * A job runs as Cloud Tasks steps (lib/taskQueue.js), all delivered
 * AT LEAST ONCE and possibly concurrently. Every step is therefore written so
 * that running it twice, or two copies at once, changes nothing:
 *
 *   create    One transaction on gradingJobLocks/{classId}_{lessonId} decides
 *             whether a job may start, so two clicks cannot start two jobs.
 *   prepare   Claimed with a fencing token (prepareEpoch). A worker whose lease
 *             was taken over can still be running, but every commit re-checks
 *             its epoch, so it can never overwrite the newer worker's results.
 *   write     One per doc. The batchUpdate carries requiredRevisionId, so a
 *             duplicate writer is refused by Google itself; a doc found already
 *             filled in is only billed when its text is provably this job's
 *             own (matchesOwnFeedback). Charges go through the per-doc ledger.
 *   finalize  Flips the job to done once, then records the summary, the bell
 *             entry and the push — each behind its own flag.
 *
 * Timestamps are epoch milliseconds (plain numbers), which keeps every lease
 * and staleness comparison a simple subtraction.
 */
const crypto = require("crypto");

const { extractDocId } = require("./googleDoc.js");
const { ReauthRequiredError } = require("./googleUserToken.js");
const { pointLedgerId } = require("./teacherPoints.js");

const JOBS = "gradingJobs";
const LOCKS = "gradingJobLocks";

/** Cloud Tasks gives an HTTP task at most this long (and so does Cloud Run). */
const PREPARE_DEADLINE_SECONDS = 30 * 60;
/**
 * A prepare claim outlives the task deadline, so the only way another worker
 * can take a job over is after Cloud Tasks has already given up on the first.
 */
const PREPARE_LEASE_MS = 35 * 60 * 1000;
/** Prepare attempts before a job is failed instead of retried again. */
const MAX_PREPARE_ATTEMPTS = 5;
/**
 * A job with no progress for this long has no task left that could run: the
 * dispatch deadline (30 min) plus the queue's --max-retry-duration (60 min, see
 * DEPLOYMENT_GUIDE.md) plus margin. Change it TOGETHER with the queue config.
 */
const JOB_STALE_MS = 2 * 60 * 60 * 1000;
/** Docs per job — one prepare transaction writes them all (limit 500). */
const MAX_DOCS = 200;
const READ_CONCURRENCY = 5;
/** Re-read + retry rounds for a write refused because the doc moved. */
const MAX_WRITE_ROUNDS = 3;

const JOB_TERMINAL = new Set(["done", "failed"]);
const DOC_FINAL = new Set([
  "written",
  "skipped",
  "failed",
  "insufficient_points",
]);
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A request the caller should answer with `status` and `{error: code}`. */
class JobError extends Error {
  constructor(status, code, params = {}) {
    super(code);
    this.name = "JobError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}

/** Not a failure — "come back later". The task route answers 503 for it. */
class RetryLater extends Error {
  constructor(reason) {
    super(reason);
    this.name = "RetryLater";
  }
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order. */
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

const warning = (code, params = {}) => ({ code, params });

// eslint-disable-next-line no-console
const info = (...args) => console.log("[GRADING-JOB]", ...args);

/**
 * @param deps.db, deps.admin
 * @param deps.docsApi         lib/googleDocsApi.js
 * @param deps.tokens          createGoogleUserTokens(...) result
 * @param deps.loadDocLib      () => Promise<lib/doc exports>
 * @param deps.gradeItems      (items, {useCache, requestId}) => results
 * @param deps.consumePoints   ({payer, docIds, classId, lessonId,
 *                             chargedByEmail, jobId}) => {point, charged, need?}
 *                             (lib/teacherPoints.js)
 * @param deps.resolvePayer    (email, classId) => teacher|null
 * @param deps.enqueue         (name, payload, opts) => Promise
 * @param deps.onFinished      { recordSummary(job), notify(job), push(job) }
 * @param deps.now             () => ms
 */
function createGradingJobs(deps) {
  const {
    db,
    docsApi,
    tokens,
    loadDocLib,
    gradeItems,
    consumePoints,
    resolvePayer,
    enqueue,
    onFinished,
    now = () => Date.now(),
  } = deps;

  const jobRef = (jobId) => db.collection(JOBS).doc(jobId);
  const docRef = (jobId, docId) => jobRef(jobId).collection("docs").doc(docId);
  const lockRef = (classId, lessonId) =>
    db.collection(LOCKS).doc(`${classId}_${lessonId}`);

  const isStale = (job) => now() - (job.progressAt || 0) > JOB_STALE_MS;

  async function readPoint(teacherId) {
    const snap = await db.collection("TeacherPoint").doc(teacherId).get();
    return snap.exists ? (snap.data().point ?? 0) : 0;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async function resolveDocIds(classId, requested) {
    if (Array.isArray(requested) && requested.length) {
      const ids = [...new Set(requested.map((id) => String(id).trim()))];
      if (ids.some((id) => !DOC_ID_PATTERN.test(id))) {
        throw new JobError(400, "invalid_doc_ids");
      }
      return ids;
    }
    const snap = await db
      .collection("students")
      .where("classId", "==", classId)
      .get();
    const ids = [];
    snap.forEach((doc) => {
      const id = extractDocId(doc.data().ggDocLink);
      if (id && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }

  /** A job that already exists under a caller-chosen id: make sure it runs. */
  async function resumeExisting(jobId, job) {
    if (job.status === "queued") {
      await enqueue(
        `prepare-${jobId}`,
        { jobId, step: "prepare" },
        { dispatchDeadlineSeconds: PREPARE_DEADLINE_SECONDS },
      );
    }
    return { jobId, existing: true };
  }

  /**
   * Starts a job, or refuses with a JobError (409 carries the running job id).
   *
   * Scheduled grading (lib/gradingSchedules.js) passes three more options:
   *  - `jobId`  a deterministic id. Calling again with the same id returns the
   *             job already created (`existing: true`) instead of a second one,
   *             so a retried step can never start the same run twice.
   *  - `origin` stored on the job, so finalize knows who owns its ending.
   *  - `guard`  async (tx) => boolean, run inside the creating transaction
   *             (reads only). false refuses with 409 `guard_rejected` — this is
   *             what makes creation atomic with the schedule being switched off.
   * Without them the behaviour is exactly the button's.
   *
   * @returns {Promise<{jobId: string, existing?: boolean}>}
   */
  async function createJob({
    email,
    authKind,
    isAdmin,
    classId,
    lessonId,
    docIds,
    useCache,
    jobId: fixedJobId = null,
    origin = null,
    guard = null,
  }) {
    classId = String(classId || "");
    lessonId = String(lessonId || "");
    if (!classId || !lessonId) {
      throw new JobError(400, "classId_and_lessonId_required");
    }
    if (fixedJobId) {
      // Checked before any validation: a retry must find its job even if the
      // class changed since (a student removed, say).
      const existing = await jobRef(fixedJobId).get();
      if (existing.exists) return resumeExisting(fixedJobId, existing.data());
    }
    const [classSnap, lessonSnap] = await Promise.all([
      db.collection("classes").doc(classId).get(),
      db.collection("lesson").doc(lessonId).get(),
    ]);
    if (!classSnap.exists) throw new JobError(404, "class_not_found");
    if (!lessonSnap.exists) throw new JobError(404, "lesson_not_found");

    const ids = await resolveDocIds(classId, docIds);
    if (!ids.length) throw new JobError(400, "no_docs");
    if (ids.length > MAX_DOCS) {
      throw new JobError(400, "too_many_docs", { max: MAX_DOCS });
    }

    // Checked up front so the teacher hears it now, not in a notification.
    if (authKind === "google" && !(await tokens.hasRefreshToken(email))) {
      throw new JobError(409, "google_reauth_required");
    }

    const payer = await resolvePayer(email, classId);
    if (!payer) throw new JobError(403, "payer_not_found");

    const jobId = fixedJobId || crypto.randomUUID().replace(/-/g, "");
    const at = now();
    const job = {
      classId,
      lessonId,
      origin,
      className: classSnap.data().name || "",
      classType: classSnap.data().classType || "",
      lessonName: lessonSnap.data().name || "",
      docIds: ids,
      // Only admins may skip the cache — same rule as /grade-cached.
      useCache: isAdmin ? useCache !== false : true,
      createdByEmail: String(email).toLowerCase(),
      authKind: authKind === "google" ? "google" : "jwt",
      payerTeacherId: payer.id,
      payerGmail: String(payer.gmail || "").toLowerCase(),
      payerName: payer.name || payer.gmail || "",
      status: "queued",
      error: null,
      errorParams: null,
      notice: null,
      noticeParams: null,
      stopped: false,
      reauthRequired: false,
      prepareEpoch: 0,
      leaseUntil: 0,
      finalizeRequested: false,
      total: ids.length,
      written: 0,
      skipped: 0,
      failed: 0,
      charged: 0,
      createdAt: at,
      progressAt: at,
      finishedAt: null,
      finalizedAt: null,
      summaryRecordedAt: null,
      notifiedAt: null,
      pushClaimedAt: null,
    };

    // The lock doc is read and written in the same transaction, so two
    // concurrent requests serialise on it: exactly one sees it free.
    const outcome = await db.runTransaction(async (tx) => {
      const lock = lockRef(classId, lessonId);
      const lockSnap = await tx.get(lock);
      if (fixedJobId) {
        const mine = await tx.get(jobRef(fixedJobId));
        if (mine.exists) return { existing: mine.data() };
      }
      let previous = null;
      if (lockSnap.exists && lockSnap.data().jobId) {
        const prevSnap = await tx.get(jobRef(lockSnap.data().jobId));
        if (prevSnap.exists) previous = prevSnap;
      }
      if (guard && !(await guard(tx))) return { rejected: true };
      if (previous && !JOB_TERMINAL.has(previous.data().status)) {
        if (!isStale(previous.data())) {
          return { conflict: previous.id };
        }
        // No task of that job can still be scheduled (see JOB_STALE_MS), and
        // failing it here makes any straggler a no-op: every step checks for a
        // terminal job before acting.
        tx.update(previous.ref, {
          status: "failed",
          error: "abandoned",
          finishedAt: at,
          finalizedAt: at,
        });
      }
      tx.set(jobRef(jobId), job);
      tx.set(lock, { jobId, classId, lessonId, updatedAt: at });
      return { conflict: null };
    });
    if (outcome.existing) return resumeExisting(jobId, outcome.existing);
    if (outcome.rejected) throw new JobError(409, "guard_rejected");
    if (outcome.conflict) {
      throw new JobError(409, "job_in_progress", { jobId: outcome.conflict });
    }

    try {
      await enqueue(
        `prepare-${jobId}`,
        { jobId, step: "prepare" },
        { dispatchDeadlineSeconds: PREPARE_DEADLINE_SECONDS },
      );
    } catch (err) {
      if (fixedJobId) {
        // The caller retries with the same id, and resumeExisting re-enqueues
        // the still-queued job. Failing it here would leave a job that never
        // reaches finalize, so its owner would never hear it ended.
        console.error("[GRADING-JOB] enqueue prepare failed:", err.message);
        throw new JobError(503, "enqueue_failed");
      }
      // Nothing will ever pick this job up — fail it now rather than leave a
      // lock that blocks the class for JOB_STALE_MS.
      await jobRef(jobId).update({
        status: "failed",
        error: "enqueue_failed",
        finishedAt: now(),
        finalizedAt: now(),
      });
      console.error("[GRADING-JOB] enqueue prepare failed:", err.message);
      throw new JobError(503, "enqueue_failed");
    }
    return { jobId };
  }

  // -------------------------------------------------------------------------
  // prepare
  // -------------------------------------------------------------------------

  /** Re-issues the tasks a committed prepare owes. Named, so repeats are free. */
  async function ensureTasks(jobId, job) {
    const pending = await jobRef(jobId)
      .collection("docs")
      .where("status", "in", ["ready", "writing"])
      .get();
    const docIds = pending.docs.map((d) => d.id);
    await mapLimit(docIds, 10, (docId) =>
      enqueue(`write-${jobId}-${docId}`, { jobId, step: "write", docId }),
    );
    if (job.finalizeRequested) {
      await enqueue(`finalize-${jobId}`, { jobId, step: "finalize" });
    }
  }

  /**
   * Commits only while `epoch` still owns the job. A worker that was taken
   * over gets `false` back and must drop what it computed.
   */
  function fencedCommit(jobId, epoch, write) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      const job = snap.exists ? snap.data() : null;
      if (
        !job ||
        job.prepareEpoch !== epoch ||
        job.status !== "preparing" ||
        job.finalizeRequested
      ) {
        return false;
      }
      write(tx, job);
      return true;
    });
  }

  /** Ends a job during prepare: nothing was written, so nothing to undo. */
  async function failPrepare(jobId, epoch, code, params = null) {
    const committed = await fencedCommit(jobId, epoch, (tx) => {
      tx.update(jobRef(jobId), {
        error: code,
        errorParams: params,
        finalizeRequested: true,
        leaseUntil: 0,
        progressAt: now(),
      });
    });
    if (committed) {
      await enqueue(`finalize-${jobId}`, { jobId, step: "finalize" });
    }
  }

  /** Reads one doc and decides whether it needs grading. */
  async function readForGrading(lib, job, docId, access) {
    let data;
    try {
      data = await docsApi.getDocument(docId, access.token);
    } catch (err) {
      if (err.kind === "auth") {
        tokens.invalidate?.(job.createdByEmail);
        throw err; // retried; a revoked grant then surfaces as reauth
      }
      if (err.kind === "transient") throw err;
      // 400/403/404: this doc cannot be read; the others still can.
      return {
        docId,
        status: "skipped",
        reason: `doc_${err.kind}`,
        warnings: [warning("failedDoc", { docId, msg: err.message })],
      };
    }

    const tab = lib.findTabByTitle(data.tabs || [], job.lessonName);
    if (!tab || !tab.documentTab) {
      return {
        docId,
        status: "skipped",
        reason: "tabMissing",
        warnings: [warning("tabMissing", { docId })],
      };
    }

    const warnings = [];
    const { rows, unclassifiedWithQuestions } = lib.collectExerciseRows(
      tab,
      job.classType,
    );
    if (!rows.length) {
      return {
        docId,
        status: "skipped",
        reason: "noTable",
        warnings: [warning("noTable", { docId })],
      };
    }
    if (unclassifiedWithQuestions.length) {
      warnings.push(
        warning("unclassifiedTable", {
          docId,
          list: unclassifiedWithQuestions.map((i) => i + 1).join(", "),
        }),
      );
    }
    const unreadable = lib.getUnreadableQuestions(rows);
    if (unreadable.length) {
      warnings.push(
        warning("unreadableAnswers", {
          docId,
          refs: unreadable.map(({ tableIdx, questionIndex }) => ({
            table: tableIdx + 1,
            question: questionIndex,
          })),
        }),
      );
    }

    const qa = lib.getQuesAndAnsFromRows(rows);
    if (!qa.length) {
      return { docId, status: "skipped", reason: "noAnswers", warnings };
    }

    // One sentence row with feedback skips EVERY sentence item of the doc — the
    // website's rule, since AI feedback cannot be told apart from what the
    // teacher typed. A paragraph is judged by its own cell instead
    // (selectItemsToGrade), so a doc graded before paragraphs existed still
    // gets its paragraph graded, and a hand-corrected one is never overwritten.
    const { reviewed, ungradedTables } = lib.describeGradedState(rows);
    if (reviewed && ungradedTables.size) {
      warnings.push(
        warning("skippedHasOldFeedback", {
          docId,
          count: ungradedTables.size,
        }),
      );
    }
    const toGrade = lib.selectItemsToGrade(rows);
    if (!toGrade.length) {
      return {
        docId,
        status: "skipped",
        reason:
          reviewed && ungradedTables.size ? "oldFeedback" : "alreadyGraded",
        warnings,
      };
    }

    return { docId, status: "pending", qa: toGrade, warnings };
  }

  /** The body of prepare, run by the worker holding `epoch`. */
  async function runPrepare(jobId, job, epoch) {
    const started = now();
    const lib = await loadDocLib();
    const access = await tokens.getDocsAccessToken(
      job.createdByEmail,
      job.authKind,
    );

    const docs = await mapLimit(job.docIds, READ_CONCURRENCY, (docId) =>
      readForGrading(lib, job, docId, access),
    );
    const readMs = now() - started;
    const pending = docs.filter((d) => d.status === "pending");

    if (pending.length) {
      // Point gate before anything is written: 1 point per doc to write.
      const have = await readPoint(job.payerTeacherId);
      if (pending.length > have) {
        await failPrepare(jobId, epoch, "not_enough_points", {
          need: pending.length,
          have,
          teacher: job.payerName,
        });
        return;
      }

      // Dedupe across the class — identical answers are graded once.
      const unique = new Map();
      for (const { qa } of pending) {
        for (const item of qa) {
          const key = lib.makeAnswerKey(item.question, item.answer, item.type);
          if (!unique.has(key)) {
            unique.set(key, {
              question: item.question,
              answer: item.answer,
              taskType: item.type,
            });
          }
        }
      }
      const graded = await gradeItems([...unique.values()], {
        useCache: job.useCache,
        requestId: jobId,
      });
      const feedbackByKey = new Map();
      for (const g of graded) {
        if (g && g.feedback !== null && g.feedback !== undefined) {
          feedbackByKey.set(
            lib.makeAnswerKey(g.question, g.answer, g.taskType),
            // formatFeedbackForDoc gộp mọi xuống dòng thành một dòng — đúng
            // cho feedback một câu (một ô bảng Markdown), nhưng sẽ phá cấu
            // trúc "câu sửa / (lý do) / dòng trống" của đoạn văn, vốn đã được
            // định dạng xong ở lib/paragraphFeedback.js.
            g.taskType === lib.KIND_PARAGRAPH
              ? g.feedback
              : lib.formatFeedbackForDoc(g.feedback),
          );
        }
      }

      for (const doc of pending) {
        doc.gradingResults = [];
        for (const item of doc.qa) {
          const feedback = feedbackByKey.get(
            lib.makeAnswerKey(item.question, item.answer, item.type),
          );
          if (feedback === null || feedback === undefined) continue;
          doc.gradingResults.push({
            rowKey: `${item.tableIdx}:${item.rowIdx}`,
            questionIndex: lib.extractQuestionIndex(item.question),
            aiFeedback: feedback,
          });
        }
        delete doc.qa;
        if (doc.gradingResults.length) {
          doc.status = "ready";
        } else {
          doc.status = "skipped";
          doc.reason = "noMatch";
          doc.warnings.push(warning("noMatch", { docId: doc.docId }));
        }
      }
    }

    const ready = docs.filter((d) => d.status === "ready");
    let notice = null;
    let noticeParams = null;
    if (!ready.length) {
      const oldFeedback = docs.filter((d) => d.reason === "oldFeedback").length;
      if (oldFeedback) {
        notice = "allSkippedOldFeedback";
        noticeParams = { count: oldFeedback };
      } else if (docs.some((d) => d.reason === "alreadyGraded")) {
        notice = "allChecked";
      } else {
        notice = "noAnswers";
      }
    }

    const committed = await fencedCommit(jobId, epoch, (tx) => {
      for (const doc of docs) {
        tx.set(docRef(jobId, doc.docId), {
          docId: doc.docId,
          status: doc.status,
          reason: doc.reason || null,
          warnings: doc.warnings,
          gradingResults: doc.gradingResults || [],
          attempts: 0,
          updatedAt: now(),
        });
      }
      tx.update(jobRef(jobId), {
        status: ready.length ? "writing" : "preparing",
        skipped: docs.length - ready.length,
        written: 0,
        failed: 0,
        notice,
        noticeParams,
        finalizeRequested: !ready.length,
        leaseUntil: 0,
        progressAt: now(),
        // Which claim's result stands — handy when reading a job that retried.
        preparedByEpoch: epoch,
      });
    });
    if (!committed) {
      info(`prepare ${jobId}: epoch ${epoch} was taken over, result dropped`);
      return;
    }
    info(
      `prepare ${jobId}: ${docs.length} docs read in ${readMs}ms, ` +
        `${ready.length} to write, total ${now() - started}ms`,
    );
    await ensureTasks(jobId, { finalizeRequested: !ready.length });
  }

  /**
   * How many students of a class did the lesson, without writing anything —
   * the same reading prepare does (readForGrading), so "pending" here is
   * exactly what a job started now would grade. Scheduled grading announces
   * this count, and reserves points for it, before starting the job.
   *
   * Throws ReauthRequiredError when the teacher's Google grant is gone, and
   * the Docs API's transient errors so the caller's step is retried.
   *
   * @returns {Promise<{total: number, pending: number, alreadyGraded: number}>}
   */
  async function countSubmissions({ classId, lessonId, email, authKind }) {
    const [classSnap, lessonSnap] = await Promise.all([
      db.collection("classes").doc(String(classId)).get(),
      db.collection("lesson").doc(String(lessonId)).get(),
    ]);
    if (!classSnap.exists) throw new JobError(404, "class_not_found");
    if (!lessonSnap.exists) throw new JobError(404, "lesson_not_found");

    const ids = await resolveDocIds(String(classId));
    if (!ids.length) return { total: 0, pending: 0, alreadyGraded: 0 };

    const lib = await loadDocLib();
    const access = await tokens.getDocsAccessToken(
      String(email).toLowerCase(),
      authKind === "google" ? "google" : "jwt",
    );
    const reading = {
      lessonName: lessonSnap.data().name || "",
      classType: classSnap.data().classType || "",
      createdByEmail: String(email).toLowerCase(),
    };
    const docs = await mapLimit(ids, READ_CONCURRENCY, (docId) =>
      readForGrading(lib, reading, docId, access),
    );
    return {
      total: ids.length,
      pending: docs.filter((d) => d.status === "pending").length,
      alreadyGraded: docs.filter(
        (d) => d.reason === "alreadyGraded" || d.reason === "oldFeedback",
      ).length,
    };
  }

  async function prepare(jobId) {
    const claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return { skip: true };
      const job = snap.data();
      if (JOB_TERMINAL.has(job.status)) return { skip: true };
      if (job.status === "writing" || job.finalizeRequested) {
        return { ensure: job };
      }
      if (job.status === "preparing" && job.leaseUntil > now()) {
        return { busy: true };
      }
      const epoch = (job.prepareEpoch || 0) + 1;
      tx.update(snap.ref, {
        status: "preparing",
        prepareEpoch: epoch,
        leaseUntil: now() + PREPARE_LEASE_MS,
        progressAt: now(),
      });
      return { job: { ...job, prepareEpoch: epoch }, epoch };
    });

    if (claim.skip) return;
    // Already committed by an earlier run: only make sure its tasks exist.
    if (claim.ensure) return ensureTasks(jobId, claim.ensure);
    // Another worker holds a live lease. Ask Cloud Tasks to come back: if that
    // worker dies, this retry is what picks the job up once the lease lapses.
    if (claim.busy) throw new RetryLater("prepare_in_progress");

    const { job, epoch } = claim;
    try {
      await runPrepare(jobId, job, epoch);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        await failPrepare(jobId, epoch, "google_reauth_required");
        return;
      }
      if (epoch >= MAX_PREPARE_ATTEMPTS) {
        console.error(`[GRADING-JOB] prepare ${jobId} gave up:`, err.message);
        await failPrepare(jobId, epoch, "prepare_failed", {
          msg: err.message,
        });
        return;
      }
      // Hand the job back so the retry does not wait out the lease.
      await fencedCommit(jobId, epoch, (tx) => {
        tx.update(jobRef(jobId), { leaseUntil: 0 });
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  /**
   * Moves a doc to a final status and counts it — once. Returns true when this
   * was the job's last doc, i.e. when the caller must enqueue finalize.
   */
  async function finishDoc(
    jobId,
    docId,
    { status, reason, warnings, charged },
  ) {
    const last = await db.runTransaction(async (tx) => {
      const [jobSnap, dSnap] = await tx.getAll(
        jobRef(jobId),
        docRef(jobId, docId),
      );
      if (!jobSnap.exists || !dSnap.exists) return false;
      const job = jobSnap.data();
      const doc = dSnap.data();
      if (JOB_TERMINAL.has(job.status) || DOC_FINAL.has(doc.status)) {
        return false;
      }
      tx.update(dSnap.ref, {
        status,
        reason: reason || null,
        warnings: [...(doc.warnings || []), ...(warnings || [])],
        updatedAt: now(),
      });
      const bucket =
        status === "written"
          ? "written"
          : status === "skipped"
            ? "skipped"
            : "failed";
      const counts = {
        written: job.written,
        skipped: job.skipped,
        failed: job.failed,
      };
      counts[bucket] += 1;
      const isLast =
        counts.written + counts.skipped + counts.failed >= job.total;
      tx.update(jobSnap.ref, {
        [bucket]: counts[bucket],
        charged: job.charged + (charged || 0),
        progressAt: now(),
        ...(isLast ? { finalizeRequested: true } : {}),
      });
      return isLast && !job.finalizeRequested;
    });
    if (last) await enqueue(`finalize-${jobId}`, { jobId, step: "finalize" });
  }

  /** ready → writing, only while the job is alive and the doc not final. */
  function markWriting(jobId, docId) {
    return db.runTransaction(async (tx) => {
      const [jobSnap, dSnap] = await tx.getAll(
        jobRef(jobId),
        docRef(jobId, docId),
      );
      if (!jobSnap.exists || !dSnap.exists) return false;
      if (JOB_TERMINAL.has(jobSnap.data().status)) return false;
      const doc = dSnap.data();
      if (DOC_FINAL.has(doc.status)) return false;
      tx.update(dSnap.ref, {
        status: "writing",
        attempts: (doc.attempts || 0) + 1,
        updatedAt: now(),
      });
      tx.update(jobSnap.ref, { progressAt: now() });
      return true;
    });
  }

  async function chargeAndFinish(jobId, job, docId) {
    const result = await consumePoints({
      payer: {
        id: job.payerTeacherId,
        gmail: job.payerGmail,
        name: job.payerName,
      },
      docIds: [docId],
      classId: job.classId,
      lessonId: job.lessonId,
      chargedByEmail: job.createdByEmail,
      jobId,
    });
    let charged = result.charged;
    if (!charged && !result.need) {
      // Nothing billable: either this job charged the doc on an attempt that
      // died before recording it, or it was paid for earlier (e.g. graded,
      // cleared by an admin, graded again). Only the first counts as ours.
      const receipt = await db
        .collection("TeacherPointLedger")
        .doc(pointLedgerId(job.payerTeacherId, docId, job.lessonId))
        .get();
      if (receipt.exists && receipt.data().jobId === jobId) charged = 1;
    }
    if (result.need) {
      // The balance was checked just before writing, so only a concurrent
      // spend lands here. The feedback is already in the doc — say it is
      // unpaid, and stop writing any more.
      await jobRef(jobId).update({ stopped: true });
      return finishDoc(jobId, docId, {
        status: "written",
        reason: "unsettled",
        warnings: [warning("unsettled", { list: docId })],
        charged: 0,
      });
    }
    return finishDoc(jobId, docId, { status: "written", charged });
  }

  /** Classifies a failed read of the doc inside write. */
  function readFailure(job, docId, err) {
    if (err.kind === "auth") {
      tokens.invalidate?.(job.createdByEmail);
      throw err;
    }
    if (err.kind === "transient") throw err;
    return {
      status: "failed",
      reason: `doc_${err.kind}`,
      warnings: [warning("failedWrite", { docId, msg: err.message })],
    };
  }

  async function write(jobId, docId) {
    const jobSnap = await jobRef(jobId).get();
    if (!jobSnap.exists) return;
    const job = jobSnap.data();
    if (JOB_TERMINAL.has(job.status)) return;
    const dSnap = await docRef(jobId, docId).get();
    if (!dSnap.exists) return;
    const record = dSnap.data();
    if (DOC_FINAL.has(record.status)) return;

    if (job.reauthRequired) {
      return finishDoc(jobId, docId, {
        status: "failed",
        reason: "google_reauth_required",
      });
    }
    if (job.stopped) {
      return finishDoc(jobId, docId, { status: "insufficient_points" });
    }

    const lib = await loadDocLib();
    let access;
    try {
      access = await tokens.getDocsAccessToken(
        job.createdByEmail,
        job.authKind,
      );
    } catch (err) {
      if (!(err instanceof ReauthRequiredError)) throw err;
      await jobRef(jobId).update({ reauthRequired: true });
      return finishDoc(jobId, docId, {
        status: "failed",
        reason: "google_reauth_required",
      });
    }

    let status = record.status; // "ready" or "writing" (a crashed attempt)
    for (let round = 0; round < MAX_WRITE_ROUNDS; round++) {
      let data;
      try {
        data = await docsApi.getDocument(docId, access.token);
      } catch (err) {
        return finishDoc(jobId, docId, readFailure(job, docId, err));
      }
      const tab = lib.findTabByTitle(data.tabs || [], job.lessonName);
      if (!tab || !tab.documentTab) {
        return finishDoc(jobId, docId, {
          status: "failed",
          reason: "tabMissing",
          warnings: [warning("tabMissing", { docId })],
        });
      }
      const { rows } = lib.collectExerciseRows(tab, job.classType);

      // Only the cells this job is about to write matter. A doc-level check
      // would refuse to write a paragraph into a doc whose sentences were
      // graded long ago — exactly the doc prepare picked it for.
      if (lib.targetsAlreadyFilled(record.gradingResults, rows)) {
        // "writing" means an earlier attempt may have written and died before
        // recording it. Bill it only if the text is provably ours.
        if (
          status === "writing" &&
          lib.matchesOwnFeedback(record.gradingResults, rows)
        ) {
          return chargeAndFinish(jobId, job, docId);
        }
        return finishDoc(jobId, docId, {
          status: "skipped",
          reason: status === "writing" ? "ownershipUnclear" : "gradedMeanwhile",
          warnings: [
            warning(
              status === "writing" ? "ownershipUnclear" : "gradedMeanwhile",
              { docId },
            ),
          ],
        });
      }

      const requests = lib.buildFeedbackRequests(
        record.gradingResults,
        rows,
        tab.tabProperties.tabId,
      );
      if (!requests.length) {
        return finishDoc(jobId, docId, {
          status: "skipped",
          reason: "noMatch",
          warnings: [warning("noMatch", { docId })],
        });
      }

      // Never write what cannot be paid for.
      if ((await readPoint(job.payerTeacherId)) < 1) {
        await jobRef(jobId).update({ stopped: true });
        return finishDoc(jobId, docId, { status: "insufficient_points" });
      }

      if (!(await markWriting(jobId, docId))) return; // job ended meanwhile
      status = "writing";

      try {
        await docsApi.batchUpdate(docId, requests, access.token, {
          requiredRevisionId: data.revisionId,
        });
      } catch (err) {
        if (err.kind === "bad_request") {
          // A 400 is either "the doc moved since you read it" or a genuinely
          // bad request. Only the revision tells them apart reliably.
          let current;
          try {
            current = await docsApi.getRevisionId(docId, access.token);
          } catch (readErr) {
            return finishDoc(jobId, docId, readFailure(job, docId, readErr));
          }
          if (current !== data.revisionId) continue; // moved: re-read, retry
          console.error(
            `[GRADING-JOB] ${jobId}/${docId} write rejected ` +
              `(${requests.length} requests): ${err.message}`,
          );
          return finishDoc(jobId, docId, {
            status: "failed",
            reason: "write_rejected",
            warnings: [warning("failedWrite", { docId, msg: err.message })],
          });
        }
        return finishDoc(jobId, docId, readFailure(job, docId, err));
      }
      return chargeAndFinish(jobId, job, docId);
    }
    throw new RetryLater("revision_conflict");
  }

  // -------------------------------------------------------------------------
  // finalize
  // -------------------------------------------------------------------------

  /** Sets `field` to now() if it is still empty; true when this call set it. */
  function claimFlag(jobId, field) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists || snap.data()[field]) return false;
      tx.update(snap.ref, { [field]: now() });
      return true;
    });
  }

  async function finalize(jobId) {
    const job = await db.runTransaction(async (tx) => {
      const snap = await tx.get(jobRef(jobId));
      if (!snap.exists) return null;
      const data = snap.data();
      if (data.finalizedAt) return data;
      const status = data.error ? "failed" : "done";
      const at = now();
      tx.update(snap.ref, {
        status,
        finalizedAt: at,
        finishedAt: at,
        progressAt: at,
        leaseUntil: 0,
      });
      return { ...data, status, finalizedAt: at, finishedAt: at };
    });
    // An abandoned job was finalized by its successor's takeover — silently.
    if (!job || job.error === "abandoned") return;

    // At least once, but idempotent: fixed ids, so a retry overwrites.
    if (!job.summaryRecordedAt && job.charged > 0) {
      await onFinished.recordSummary({ ...job, id: jobId });
      await jobRef(jobId).update({ summaryRecordedAt: now() });
    }
    if (!job.notifiedAt) {
      await onFinished.notify({ ...job, id: jobId });
      await jobRef(jobId).update({ notifiedAt: now() });
    }
    // At most once: claim first, then send. A crash in between loses a push,
    // never duplicates one — the bell entry above is the durable copy.
    if (await claimFlag(jobId, "pushClaimedAt")) {
      await onFinished
        .push({ ...job, id: jobId })
        .catch((err) =>
          console.error("[GRADING-JOB] push failed:", err.message),
        );
    }
  }

  // -------------------------------------------------------------------------
  // tasks + reads
  // -------------------------------------------------------------------------

  async function handleTask(payload) {
    const jobId = String(payload?.jobId || "");
    if (!jobId) return;
    if (payload.step === "prepare") return prepare(jobId);
    if (payload.step === "write") {
      return write(jobId, String(payload.docId || ""));
    }
    if (payload.step === "finalize") return finalize(jobId);
  }

  function canView(job, viewer) {
    const email = String(viewer.email || "").toLowerCase();
    return (
      viewer.isAdmin || job.createdByEmail === email || job.payerGmail === email
    );
  }

  /** What the grading screen shows. Nothing secret, nothing internal. */
  async function describe(jobId, job) {
    const docsSnap = await jobRef(jobId).collection("docs").get();
    const warnings = [];
    docsSnap.forEach((d) => warnings.push(...(d.data().warnings || [])));
    if (job.stopped) warnings.push(warning("stoppedNoPoints"));
    return {
      id: jobId,
      status: job.status,
      error: job.error,
      errorParams: job.errorParams,
      notice: job.notice,
      noticeParams: job.noticeParams,
      classId: job.classId,
      lessonId: job.lessonId,
      className: job.className,
      lessonName: job.lessonName,
      total: job.total,
      written: job.written,
      skipped: job.skipped,
      failed: job.failed,
      charged: job.charged,
      stopped: job.stopped,
      reauthRequired: job.reauthRequired,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      origin: job.origin ? { type: job.origin.type } : null,
      warnings,
    };
  }

  async function getJob(jobId, viewer) {
    const snap = await jobRef(String(jobId)).get();
    if (!snap.exists || !canView(snap.data(), viewer)) {
      throw new JobError(404, "job_not_found");
    }
    return describe(snap.id, snap.data());
  }

  /** The job most recently started for this class + lesson, or null. */
  async function getLatestJob(classId, lessonId, viewer) {
    const lock = await lockRef(String(classId), String(lessonId)).get();
    if (!lock.exists) return null;
    const snap = await jobRef(lock.data().jobId).get();
    if (!snap.exists || !canView(snap.data(), viewer)) return null;
    return describe(snap.id, snap.data());
  }

  return {
    countSubmissions,
    createJob,
    finalize,
    getJob,
    getLatestJob,
    handleTask,
    prepare,
    write,
  };
}

module.exports = {
  JOB_STALE_MS,
  JOB_TERMINAL,
  JobError,
  MAX_PREPARE_ATTEMPTS,
  PREPARE_LEASE_MS,
  RetryLater,
  createGradingJobs,
};
