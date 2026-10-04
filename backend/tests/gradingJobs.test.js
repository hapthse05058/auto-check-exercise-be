const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { DocsApiError } = require("../lib/googleDocsApi.js");
const { ReauthRequiredError } = require("../lib/googleUserToken.js");
const {
  JOB_STALE_MS,
  JobError,
  PREPARE_LEASE_MS,
} = require("../lib/gradingJobs.js");
const { consumePointsForDocs } = require("../lib/teacherPoints.js");
const { P, createHarness, makeTab } = require("./helpers/gradingHarness.js");

/** Two students to write, one already graded, one without the lesson tab. */
const classOfFour = () => ({
  docA: makeTab({ answers: ["I done it", "ok answer"] }),
  docB: makeTab({ answers: ["ok one", "ok two"] }),
  docGraded: makeTab({ answers: ["x"], feedback: ["Cô đã chữa"] }),
  docNoTab: makeTab({ answers: ["x"], title: "BUỔI 99" }),
});

const CORRECTION = "She has done it.\n(Sai thì.)";

async function runJob(h, overrides) {
  const { jobId } = await h.start(overrides);
  await h.drain();
  return jobId;
}

/** Starts a job and runs ONLY its prepare step. */
async function prepared(h, overrides) {
  const { jobId } = await h.start(overrides);
  const task = h.queue.pending.shift();
  await h.jobs.handleTask(task.payload);
  return jobId;
}

/** The teacher types into feedback cell `i` of a doc (a real edit: new revision). */
function teacherTypes(h, docId, i, text) {
  h.docsApi.edit(docId, (tab) => {
    const cell =
      tab.documentTab.body.content[0].table.tableRows[2 + i].tableCells[2];
    cell.content = [P(`${text}\n`, cell.content[0].startIndex)];
  });
}

async function until(predicate) {
  for (let i = 0; i < 1000 && !predicate(); i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(predicate(), "condition never became true");
}

describe("grading job: whole run", () => {
  it("writes, charges and announces a class without any browser", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await runJob(h);
    const job = h.job(jobId);

    assert.equal(job.status, "done");
    assert.equal(job.total, 4);
    assert.equal(job.written, 2);
    assert.equal(job.skipped, 2);
    assert.equal(job.charged, 2);
    assert.equal(h.points(), 8);
    assert.equal(h.ledger().length, 2);
    assert.ok(h.ledger().every((r) => r.jobId === jobId));

    // Bold markers became styling; the reason sits on its own line.
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [CORRECTION, "✅ Đúng"]);
    assert.deepEqual(h.docsApi.feedbackOf("docB"), ["✅ Đúng", "✅ Đúng"]);
    assert.match(h.docsApi.overallOf("docB"), /Làm tốt lắm/);
    // Nothing touched in the docs that were skipped.
    assert.deepEqual(h.docsApi.feedbackOf("docGraded"), ["Cô đã chữa"]);

    assert.equal(h.counters.grade, 1, "graded once for the whole class");
    assert.equal(h.counters.summary, 1);
    assert.equal(h.counters.notify, 1);
    assert.equal(h.counters.push, 1);

    const view = await h.jobs.getJob(jobId, { email: "teacher@x.com" });
    assert.deepEqual(
      view.warnings.map((w) => w.code),
      ["tabMissing"],
    );
  });

  it("re-running a graded lesson writes and charges nothing", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    await runJob(h);
    const again = await runJob(h);

    const job = h.job(again);
    assert.equal(job.status, "done");
    assert.equal(job.written, 0);
    assert.equal(job.notice, "allChecked");
    assert.equal(h.points(), 8);
    assert.equal(h.docsApi.calls.applied, 2);
  });

  it("grades only the pasted docs when links are given", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await runJob(h, { docIds: ["docB"] });
    assert.equal(h.job(jobId).total, 1);
    assert.equal(h.job(jobId).written, 1);
    assert.deepEqual(h.docsApi.feedbackOf("docA"), ["", ""]);
  });

  it("only the starter, the payer and admins can see a job", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await runJob(h);
    await assert.rejects(h.jobs.getJob(jobId, { email: "other@x.com" }), {
      code: "job_not_found",
    });
    const asAdmin = await h.jobs.getJob(jobId, {
      email: "boss@x.com",
      isAdmin: true,
    });
    assert.equal(asAdmin.id, jobId);
    const latest = await h.jobs.getLatestJob("c1", "l10", {
      email: "teacher@x.com",
    });
    assert.equal(latest.id, jobId);
  });
});

describe("starting a job", () => {
  it("five simultaneous clicks start exactly one job", async () => {
    const h = createHarness({ tabs: classOfFour() });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => h.start()),
    );
    const started = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    assert.equal(started.length, 1);
    assert.equal(refused.length, 4);
    for (const r of refused) {
      assert.ok(r.reason instanceof JobError);
      assert.equal(r.reason.status, 409);
      assert.equal(r.reason.params.jobId, started[0].value.jobId);
    }
    assert.equal(Object.keys(h.db.dump("gradingJobs")).length, 1);
  });

  it("never takes over a job that is still making progress", async () => {
    const h = createHarness({ tabs: classOfFour() });
    const { jobId } = await h.start();
    h.advance(JOB_STALE_MS - 1000);

    // The prepare step runs (and stalls in grading) — that is progress.
    let release;
    h.hooks.gradeGate = new Promise((r) => (release = r));
    const task = h.queue.pending.shift();
    const running = h.jobs.handleTask(task.payload);
    await until(() => h.counters.grade === 1);

    // Older than JOB_STALE_MS in total, but it moved recently.
    h.advance(JOB_STALE_MS - 1000);
    await assert.rejects(h.start(), (err) => err.status === 409);

    release();
    await running;
    await h.drain();
    assert.equal(h.job(jobId).status, "done");
  });

  it("takes over a job with no progress at all, and its leftovers do nothing", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const { jobId: dead } = await h.start();
    h.advance(JOB_STALE_MS + 1);
    const { jobId: fresh } = await h.start();

    assert.equal(h.job(dead).status, "failed");
    assert.equal(h.job(dead).error, "abandoned");
    // The dead job's prepare is still queued: it must not act.
    await h.drain();
    assert.equal(h.job(fresh).status, "done");
    assert.equal(h.job(dead).written, 0);
    assert.equal(h.points(), 8, "charged once, by the fresh job");
    assert.equal(h.counters.notify, 1, "the abandoned job announces nothing");
  });

  it("refuses a Google user whose refresh token is not stored", async () => {
    const h = createHarness({ tabs: classOfFour() });
    h.hooks.noStoredToken = true;
    await assert.rejects(h.start(), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, "google_reauth_required");
      return true;
    });
  });
});

describe("prepare step", () => {
  it("a retried prepare neither re-grades nor re-queues writes", async () => {
    const h = createHarness({ tabs: classOfFour() });
    const { jobId } = await h.start();
    const task = h.queue.pending.shift();
    await h.jobs.handleTask(task.payload);
    const queued = h.queue.pending.length;
    await h.jobs.handleTask(task.payload); // Cloud Tasks delivers it again
    assert.equal(h.counters.grade, 1);
    assert.equal(h.queue.pending.length, queued);
    await h.drain();
    assert.equal(h.job(jobId).written, 2);
  });

  it("answers 'retry later' while another worker holds a live lease", async () => {
    const h = createHarness({ tabs: classOfFour() });
    await h.start();
    let release;
    h.hooks.gradeGate = new Promise((r) => (release = r));
    const task = h.queue.pending.shift();
    const first = h.jobs.handleTask(task.payload);
    await until(() => h.counters.grade === 1);
    await assert.rejects(h.jobs.handleTask(task.payload), {
      name: "RetryLater",
    });
    release();
    await first;
  });

  it("a worker whose lease was taken over cannot overwrite the newer result", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const { jobId } = await h.start();
    const task = h.queue.pending.shift();

    // Worker A claims (epoch 1) and stalls in grading past its lease.
    let releaseA;
    h.hooks.gradeGate = new Promise((r) => (releaseA = r));
    const workerA = h.jobs.handleTask(task.payload);
    await until(() => h.counters.grade === 1);
    h.advance(PREPARE_LEASE_MS + 1);

    // Worker B takes over (epoch 2), commits, and the docs get written.
    await h.jobs.handleTask(task.payload);
    await h.drain();
    assert.equal(h.job(jobId).status, "done");
    const before = h.docRecords(jobId);

    // A wakes up and tries to commit its (stale) view: refused.
    releaseA();
    await workerA;
    assert.deepEqual(h.docRecords(jobId), before);
    assert.equal(h.job(jobId).prepareEpoch, 2);
    assert.equal(h.docsApi.calls.applied, 2);
    assert.equal(h.points(), 8);
  });

  it("the taken-over worker loses even when it finishes first", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const { jobId } = await h.start();
    const task = h.queue.pending.shift();

    let releaseA;
    h.hooks.gradeGate = new Promise((r) => (releaseA = r));
    const workerA = h.jobs.handleTask(task.payload);
    await until(() => h.counters.grade === 1);
    h.advance(PREPARE_LEASE_MS + 1);

    // B claims (epoch 2) and is still grading when A wakes up and commits.
    let releaseB;
    h.hooks.gradeGate = new Promise((r) => (releaseB = r));
    const workerB = h.jobs.handleTask(task.payload);
    await until(() => h.counters.grade === 2);
    releaseA();
    await workerA;
    assert.equal(h.job(jobId).status, "preparing", "A's commit was refused");

    releaseB();
    await workerB;
    assert.equal(h.job(jobId).preparedByEpoch, 2);
    await h.drain();
    assert.equal(h.job(jobId).written, 2);
    assert.equal(h.points(), 8);
  });

  it("a transient read failure hands the job back and the retry finishes it", async () => {
    const h = createHarness({ tabs: classOfFour() });
    h.docsApi.failNext("get", new DocsApiError(503, "backend error"));
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).status, "done");
    assert.equal(h.job(jobId).prepareEpoch, 2);
  });

  it("gives up after repeated failures and says so once", async () => {
    const h = createHarness({ tabs: classOfFour() });
    h.docsApi.failNext("get", () => new DocsApiError(503, "down"), {
      times: 1000,
    });
    const jobId = await runJob(h);
    const job = h.job(jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "prepare_failed");
    assert.equal(h.docsApi.calls.applied, 0);
    assert.equal(h.counters.notify, 1);
  });

  it("refuses to start writing when the balance cannot cover the docs", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 1 });
    const jobId = await runJob(h);
    const job = h.job(jobId);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "not_enough_points");
    assert.deepEqual(job.errorParams, {
      need: 2,
      needVnd: 1600,
      haveVnd: 800,
      teacher: "Cô Hà",
    });
    assert.equal(h.docsApi.calls.batchUpdate, 0);
    assert.equal(h.points(), 1);
  });
});

describe("write step: crash windows", () => {
  it("dies before the write reached Google: the retry writes it once", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    h.docsApi.failNext("batchUpdate", new DocsApiError(0, "reset"), {
      docId: "docA",
    });
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).written, 2);
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [CORRECTION, "✅ Đúng"]);
    assert.equal(h.points(), 8);
  });

  it("the write landed but its response was lost: billed once, not rewritten", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    h.docsApi.failNext("batchUpdate", new DocsApiError(0, "reset"), {
      docId: "docA",
      phase: "after",
    });
    const jobId = await runJob(h);
    assert.equal(h.docsApi.calls.applied, 2, "docA applied exactly once");
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [CORRECTION, "✅ Đúng"]);
    assert.equal(h.points(), 8);
    assert.equal(h.ledger().length, 2);
    assert.equal(h.job(jobId).written, 2);
    assert.equal(h.job(jobId).charged, 2);
  });

  it("charged, then died before recording it: no second charge, count stays right", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    let crashed = false;
    h.hooks.afterConsume = async ({ docIds }) => {
      if (docIds[0] === "docA" && !crashed) {
        crashed = true;
        throw new Error("instance stopped");
      }
    };
    const jobId = await runJob(h);
    assert.equal(h.points(), 8);
    assert.equal(h.ledger().length, 2);
    assert.equal(h.job(jobId).charged, 2, "the summary reports what was spent");
    assert.equal(h.docsApi.calls.applied, 2);
  });

  it("the same write delivered twice at once: one write, one charge", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await prepared(h);
    const writeA = h.queue.pending.find((t) => t.payload.docId === "docA");
    await Promise.all([
      h.jobs.handleTask(writeA.payload),
      h.jobs.handleTask(writeA.payload),
    ]);
    await h.drain();

    assert.deepEqual(h.docsApi.feedbackOf("docA"), [CORRECTION, "✅ Đúng"]);
    assert.equal(h.docsApi.calls.applied, 2, "docA once, docB once");
    assert.equal(h.points(), 8);
    assert.equal(h.job(jobId).written, 2);
    assert.equal(h.job(jobId).charged, 2);
  });

  it("a doc already paid for by an earlier run is written without a new charge", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    // e.g. graded before, then cleared by an admin: its receipt still exists.
    await consumePointsForDocs(h.db, h.admin, {
      payer: { id: "t1", gmail: "teacher@x.com", name: "Cô Hà" },
      docIds: ["docA"],
      classId: "c1",
      lessonId: "l10",
      chargedByEmail: "teacher@x.com",
      unitPriceVnd: 800,
      jobId: "an-older-job",
    });
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).written, 2);
    assert.equal(h.job(jobId).charged, 1, "only docB is this job's spend");
    assert.equal(h.job(jobId).alreadyPaid, 1, "docA is counted as prepaid");
    assert.equal(h.points(), 8);
  });

  it("a run whose docs were all paid for before still logs its summary", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    await consumePointsForDocs(h.db, h.admin, {
      payer: { id: "t1", gmail: "teacher@x.com", name: "Cô Hà" },
      docIds: ["docA", "docB"],
      classId: "c1",
      lessonId: "l10",
      chargedByEmail: "teacher@x.com",
      unitPriceVnd: 800,
      jobId: "an-older-job",
    });
    const jobId = await runJob(h);
    const job = h.job(jobId);
    assert.equal(job.written, 2);
    assert.equal(job.charged, 0);
    assert.equal(job.alreadyPaid, 2);
    assert.equal(h.points(), 8, "nothing charged twice");
    // The audit log says why nothing was charged instead of saying nothing.
    assert.equal(h.counters.summary, 1);
    const view = await h.jobs.getJob(jobId, { email: "teacher@x.com" });
    assert.equal(view.alreadyPaid, 2);
  });
});

describe("write step: failures are classified, not guessed", () => {
  it("a 400 on an unchanged doc is a bad request: failed, never retried", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    h.docsApi.failNext("batchUpdate", new DocsApiError(400, "Invalid index"), {
      docId: "docA",
    });
    const jobId = await runJob(h);
    const docA = h.docRecords(jobId).docA;
    assert.equal(docA.status, "failed");
    assert.equal(docA.reason, "write_rejected");
    assert.deepEqual(h.docsApi.feedbackOf("docA"), ["", ""]);
    assert.ok(
      h.queue.log.every((entry) => entry.ok),
      "no task was retried",
    );
    assert.equal(h.points(), 9, "only docB was paid for");
    assert.equal(h.job(jobId).status, "done");
  });

  it("a 400 because the doc moved is re-read and written against the new revision", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await prepared(h);
    // Between the write step's read and its write, the teacher edits an
    // unrelated cell: the write is refused, re-read, and goes through.
    h.docsApi.failNext(
      "batchUpdate",
      () => {
        h.docsApi.edit("docA", () => {});
        return null;
      },
      { docId: "docA" },
    );
    await h.drain();
    assert.equal(h.docRecords(jobId).docA.status, "written");
    assert.deepEqual(h.docsApi.feedbackOf("docA"), [CORRECTION, "✅ Đúng"]);
  });

  it("a doc that stopped being shared fails on its own; the rest carry on", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await prepared(h);
    h.docsApi.failNext("get", new DocsApiError(403, "forbidden"), {
      docId: "docA",
    });
    await h.drain();
    const docA = h.docRecords(jobId).docA;
    assert.equal(docA.status, "failed");
    assert.equal(docA.reason, "doc_forbidden");
    assert.equal(h.job(jobId).written, 1);
  });

  it("429 / 5xx are retried until they go through", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    h.docsApi.failNext("batchUpdate", new DocsApiError(429, "quota"), {
      docId: "docA",
      times: 2,
    });
    const jobId = await runJob(h);
    assert.equal(h.docRecords(jobId).docA.status, "written");
    assert.equal(h.points(), 8);
  });
});

describe("write step: whose feedback is it?", () => {
  it("feedback typed in after grading started is left alone, unbilled", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await prepared(h);
    teacherTypes(h, "docA", 0, "Cô chữa tay");
    await h.drain();
    const docA = h.docRecords(jobId).docA;
    assert.equal(docA.status, "skipped");
    assert.equal(docA.reason, "gradedMeanwhile");
    assert.deepEqual(h.docsApi.feedbackOf("docA"), ["Cô chữa tay", ""]);
    assert.equal(h.points(), 9);
  });

  it("a crashed attempt finds someone else's text: not claimed, not billed", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    // The write fails before reaching Google, and before the retry the
    // teacher fills the cell in by hand.
    h.docsApi.failNext(
      "batchUpdate",
      () => {
        teacherTypes(h, "docA", 0, "Cô chữa tay");
        return new DocsApiError(0, "reset");
      },
      { docId: "docA" },
    );
    const jobId = await runJob(h);
    const docA = h.docRecords(jobId).docA;
    assert.equal(docA.status, "skipped");
    assert.equal(docA.reason, "ownershipUnclear");
    assert.equal(h.points(), 9);
    const view = await h.jobs.getJob(jobId, { email: "teacher@x.com" });
    assert.ok(view.warnings.some((w) => w.code === "ownershipUnclear"));
  });
});

describe("points and identity running out mid-job", () => {
  it("stops before writing what it cannot charge for", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 2 });
    const jobId = await prepared(h);
    // Something else spends one doc's worth after the gate passed.
    h.db._apply({
      type: "update",
      path: "TeacherPoint/t1",
      data: { balanceVnd: 800 },
    });
    await h.drain();
    const docs = h.docRecords(jobId);
    assert.equal(docs.docA.status, "written");
    assert.equal(docs.docB.status, "insufficient_points");
    assert.deepEqual(h.docsApi.feedbackOf("docB"), ["", ""]);
    assert.equal(h.points(), 0);
    const view = await h.jobs.getJob(jobId, { email: "teacher@x.com" });
    assert.ok(view.warnings.some((w) => w.code === "stoppedNoPoints"));
  });

  it("a revoked Google grant ends the job cleanly and asks to sign in again", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    // Call 1 = prepare, 2 = write docA, 3 = write docB.
    h.hooks.tokenError = (n) => (n >= 3 ? new ReauthRequiredError() : null);
    const jobId = await runJob(h);
    const docs = h.docRecords(jobId);
    assert.equal(docs.docA.status, "written");
    assert.equal(docs.docB.status, "failed");
    assert.equal(docs.docB.reason, "google_reauth_required");
    const job = h.job(jobId);
    assert.equal(job.reauthRequired, true);
    assert.equal(job.status, "done");
    assert.equal(h.counters.notify, 1);
    const notified = h.finished.find((f) => f.kind === "notify").job;
    assert.equal(notified.reauthRequired, true);
    assert.ok(
      h.queue.log.every((entry) => entry.ok),
      "reauth is not retried",
    );
  });

  it("a grant revoked before the job started fails it before anything is read", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    h.hooks.tokenError = () => new ReauthRequiredError();
    const jobId = await runJob(h);
    assert.equal(h.job(jobId).status, "failed");
    assert.equal(h.job(jobId).error, "google_reauth_required");
    assert.equal(h.docsApi.calls.get, 0);
  });
});

describe("finalize", () => {
  it("delivered three more times: one summary, one bell entry, one push", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const jobId = await runJob(h);
    const finalizedAt = h.job(jobId).finalizedAt;
    for (let i = 0; i < 3; i++) {
      h.advance(1000);
      await h.jobs.handleTask({ jobId, step: "finalize" });
    }
    assert.equal(h.counters.summary, 1);
    assert.equal(h.counters.notify, 1);
    assert.equal(h.counters.push, 1);
    assert.equal(h.job(jobId).finalizedAt, finalizedAt);
  });

  it("two finalizers at the same moment push once", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 10 });
    const { jobId } = await h.start();
    // Run everything except finalize, then deliver finalize twice at once.
    await h.queue.drain((p) =>
      p.step === "finalize" ? undefined : h.jobs.handleTask(p),
    );
    assert.equal(h.job(jobId).finalizeRequested, true);
    await Promise.all([
      h.jobs.handleTask({ jobId, step: "finalize" }),
      h.jobs.handleTask({ jobId, step: "finalize" }),
    ]);
    assert.equal(h.job(jobId).status, "done");
    assert.equal(h.counters.push, 1);
    // Summary and bell may both run in a true race, but they write fixed ids
    // (grading-summary-<job>, notificationId(job)), so a second run overwrites
    // the same row rather than adding one.
    assert.ok(h.counters.notify >= 1 && h.counters.notify <= 2);
  });
});

describe("charging", () => {
  it("two simultaneous charges for one doc bill it once", async () => {
    const h = createHarness({ tabs: classOfFour(), points: 5 });
    const charge = {
      payer: { id: "t1", gmail: "teacher@x.com", name: "Cô Hà" },
      docIds: ["docA"],
      classId: "c1",
      lessonId: "l10",
      chargedByEmail: "teacher@x.com",
      unitPriceVnd: 800,
    };
    const [a, b] = await Promise.all([
      consumePointsForDocs(h.db, h.admin, charge),
      consumePointsForDocs(h.db, h.admin, charge),
    ]);
    assert.equal(a.charged + b.charged, 1);
    assert.equal(h.points(), 4);
    assert.equal(h.ledger().length, 1);
  });
});
