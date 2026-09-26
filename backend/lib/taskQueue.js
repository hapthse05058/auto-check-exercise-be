/**
 * Durable background work for grading jobs.
 *
 * Cloud Run throttles CPU once a response is sent and may stop an instance at
 * any time, so a job cannot simply keep running after the request that created
 * it. Each step is instead a Cloud Tasks task that POSTs back to this service
 * (see /internal/tasks/grading), retried by Google until it answers 2xx.
 *
 * Every task is NAMED. Cloud Tasks refuses a second task with a name it has
 * already seen (ALREADY_EXISTS), which is what makes "enqueue the write for
 * this doc" safe to repeat from a retried step: it happens at most once.
 *
 * TASKS_MODE=inline runs the same handler in-process instead, so local dev
 * needs no GCP. It honours the naming rule and retries failures with a short
 * backoff, but it is NOT durable — a restart loses queued work.
 */

/** Cloud Tasks gRPC status for a name that was already used. */
const ALREADY_EXISTS = 6;

/** Task names allow [A-Za-z0-9_-] only. */
function safeTaskName(name) {
  return String(name)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 400);
}

function createCloudQueue({
  project,
  location,
  queue,
  targetUrl,
  invokerServiceAccount,
}) {
  for (const [key, value] of Object.entries({
    TASKS_PROJECT: project,
    TASKS_LOCATION: location,
    TASKS_QUEUE: queue,
    TASKS_TARGET_URL: targetUrl,
    TASKS_INVOKER_SA: invokerServiceAccount,
  })) {
    if (!value) throw new Error(`${key} is required when TASKS_MODE=cloud`);
  }
  // Required lazily: inline mode (dev, tests) never loads the gRPC client.
  const { CloudTasksClient } = require("@google-cloud/tasks");
  const client = new CloudTasksClient();
  const parent = client.queuePath(project, location, queue);

  async function enqueue(name, payload, { dispatchDeadlineSeconds } = {}) {
    const task = {
      name: client.taskPath(project, location, queue, safeTaskName(name)),
      httpRequest: {
        httpMethod: "POST",
        url: targetUrl,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        oidcToken: {
          serviceAccountEmail: invokerServiceAccount,
          audience: targetUrl,
        },
      },
    };
    if (dispatchDeadlineSeconds) {
      task.dispatchDeadline = { seconds: dispatchDeadlineSeconds };
    }
    try {
      await client.createTask({ parent, task });
      return { created: true };
    } catch (err) {
      if (err.code === ALREADY_EXISTS) return { created: false };
      throw err;
    }
  }

  return { enqueue, mode: "cloud" };
}

/**
 * @param handler async (payload) => void. Throwing means "retry me".
 */
function createInlineQueue({ handler, maxAttempts = 5, baseDelayMs = 1000 }) {
  const seen = new Set();

  async function run(payload, attempt) {
    try {
      await handler(payload);
    } catch (err) {
      if (attempt >= maxAttempts) {
        console.error(
          `[TASKS] inline task gave up after ${attempt} attempts:`,
          err.message,
        );
        return;
      }
      setTimeout(
        () => run(payload, attempt + 1),
        baseDelayMs * 2 ** (attempt - 1),
      );
    }
  }

  async function enqueue(name, payload) {
    const key = safeTaskName(name);
    if (seen.has(key)) return { created: false };
    seen.add(key);
    setImmediate(() => run(payload, 1));
    return { created: true };
  }

  return { enqueue, mode: "inline" };
}

module.exports = {
  ALREADY_EXISTS,
  createCloudQueue,
  createInlineQueue,
  safeTaskName,
};
