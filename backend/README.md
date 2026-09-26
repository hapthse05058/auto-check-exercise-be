Mama Agent Backend

This small Express service exposes the Mama grading agent via a simple HTTP API.

Endpoints

- GET /prompt
  - Returns the currently configured Mama prompt.

- POST /prompt
  - Body: { "prompt": "..." }
  - Saves a new prompt to be used for grading.

- POST /grade
  - Body: { "items": ["student sentence 1", "student sentence 2", ...] }
  - Calls the OpenAI API with the configured Mama prompt and returns the raw model output and parsed JSON (if model returned JSON).

Setup

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

2. (Optional) Set `MAMA_PROMPT` in `.env` or use `POST /prompt` to set it at runtime.

3. Install and run:

```bash
cd backend
npm install
npm start
```

Example request (curl):

```bash
curl -X POST http://localhost:3000/grade \
  -H "Content-Type: application/json" \
  -d '{"items":["1. Student sentence here","2. Another sentence"]}'
```

Audit log

Every state-changing request is recorded automatically into the `auditLogs`
Firestore collection by `auditMiddleware` in `server.js`. Admins read the trail
through `GET /audit-logs` (the website's `/admin/audit-logs` screen).

- `lib/auditActions.js` — the only file that knows about routes. Adding an API
  means adding one row to `AUDIT_ACTIONS` (action name, resource type,
  severity); the middleware, the filter dropdowns and the client-event
  whitelist all read from it. An unlisted route is still logged, under a generic
  `METHOD /path` action name.
- `lib/auditLog.js` — technical only: redact → serialize → truncate → write. It
  contains no route names. Credentials are redacted by key name, recursively, so
  `password` / `token` / `code` never reach the log wherever they are nested.
- GETs are not audited (except entries added to `AUDITED_GETS`), and
  `/auth/refresh` + `/auth/google-token` are skipped entirely — the website
  refreshes tokens every 60s per open tab.

Retention is 60 days (`AUDIT_RETENTION_DAYS`). Each document carries an
`expireAt` timestamp; enable a **Firestore TTL policy** on
`auditLogs.expireAt` so Google deletes expired entries at no cost.

`--database` is REQUIRED and the policy is PER DATABASE: without it gcloud
silently targets `(default)` only, which is how the dev database ended up
with no policy at all. Run it for BOTH:

```bash
gcloud firestore fields ttls update expireAt \
  --collection-group=auditLogs --database="auto-check-exer-dev" --enable-ttl --async
gcloud firestore fields ttls update expireAt \
  --collection-group=auditLogs --database="(default)" --enable-ttl --async
```

Enabled 2026-08-30 on both databases (state `CREATING` -> `ACTIVE`; the first
sweep can take up to 24h). Verify with
`gcloud firestore fields ttls list --database=<id>`.

Until that policy is enabled (or to clear a backlog immediately), run the
manual fallback:

```bash
node scripts/purgeAuditLogs.js --dry-run   # count only
node scripts/purgeAuditLogs.js             # delete
```

**Changing a retention window only affects NEW documents.** `expireAt` is
stamped by the writer at insert time, so rows already stored keep the expiry
they were born with — raise `AUDIT_RETENTION_DAYS` and the existing rows still
disappear on the old schedule. `scripts/backfillRetention.js` re-stamps them
(`expireAt = createdAt + <current retention>`) for both `auditLogs` and
`notifications`. It is idempotent and per database:

```bash
node scripts/backfillRetention.js --database="auto-check-exer-dev" --dry-run
node scripts/backfillRetention.js --database="auto-check-exer-dev"
node scripts/backfillRetention.js --database="(default)" --dry-run
node scripts/backfillRetention.js --database="(default)"
```

Run 2026-08-30 after auditLogs went 30d -> 60d and notifications 90d -> 30d:
497 audit rows extended, 3 notifications shortened.

DeepSeek balance alert

The admin is warned — in-app bell plus FCM web push — when the DeepSeek
platform balance drops below a per-currency threshold, so the account can be
topped up before grading starts failing.

- `lib/deepseekBalance.js` — pure decision logic (parse `GET /user/balance`,
  per-currency thresholds, the alert state machine). Fully unit-tested in
  `tests/deepseekBalance.test.js`; no Firestore, no network except
  `fetchBalance`.
- `lib/balanceMonitor.js` — the orchestrator: throttle, state, deliver.
- `lib/notifications.js` / `lib/pushDevices.js` — the bell store and the FCM
  device registry.

The check runs opportunistically off the grading routes (`/grade-cached` and
`/grade`), fired without `await` so it can never block or break grading. It is
throttled to roughly one check an hour by a Firestore transaction that claims
`systemState/deepseekBalance.lastCheckedAt` _before_ the outbound call, which is
what keeps multiple Cloud Run instances from all calling DeepSeek at once. While
the balance stays low, a reminder is re-sent at most once every
`DEEPSEEK_LOW_BALANCE_REALERT_HOURS` (24h) rather than on every run.

Thresholds are per currency (`DEEPSEEK_LOW_BALANCE_USD` /
`DEEPSEEK_LOW_BALANCE_CNY`) and compared directly against whatever currency the
API returns — no FX conversion, since a stale hard-coded rate would silently
move the alert point. A currency with no configured threshold is never judged
low. See `.env.example` for the full list of knobs.

To verify the alert path without draining the account, raise the threshold
temporarily and force a check (`force=1` bypasses both the throttle and the
re-alert window):

```bash
curl -X POST -H "x-api-key: $EXTENSION_SECRET_KEY" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  "http://localhost:3000/admin/deepseek-balance/check?force=1"
```

Notifications live in the `notifications` collection and are kept
`NOTIFICATION_RETENTION_DAYS` (30). Like `auditLogs`, each document carries an
`expireAt`, so enable the matching TTL policy on BOTH databases (see the
`--database` note in the audit log section above):

```bash
gcloud firestore fields ttls update expireAt \
  --collection-group=notifications --database="auto-check-exer-dev" --enable-ttl --async
gcloud firestore fields ttls update expireAt \
  --collection-group=notifications --database="(default)" --enable-ttl --async
```

Enabled 2026-08-30 on both databases. The collection does not need to exist
yet - Firestore accepts a TTL policy on a field that has no documents, which
is how this was enabled on production before the first alert ever fired.

FCM registration tokens live in `fcmTokens`, keyed by `sha256(token)`. The
device-registration route names its body field `token` on purpose: that key is
in `REDACT_KEYS`, so the raw token — a capability to push to that device — never
reaches the audit log. Only the hash appears in URLs and audit rows.

Web push is configured entirely on the website side. Its seven
`VITE_FIREBASE_*` variables live in `auto-check-exercise-website/.env` (see the
`.env.example` there), and because `.env` is gitignored they must ALSO be
entered by hand in Vercel -> Settings -> Environment Variables. Vite inlines
`import.meta.env.*` at BUILD time, so adding them on Vercel has no effect until
the next **redeploy**.

Two of those values need care:

- The six `firebaseConfig` fields are duplicated in
  `auto-check-exercise-website/public/firebase-messaging-sw.js` — a classic
  service worker cannot read `import.meta.env`. Keep both copies in sync.
- `VITE_FIREBASE_VAPID_KEY` lives ONLY in the env, never in the service worker:
  the worker only receives messages, and just the page calls `getToken()`.

Backend needs no FCM key at all — `firebase-admin` mints FCM v1 credentials from
the existing service account. `PUBLIC_WEB_URL` is the only related backend
variable; it is the link a pushed notification opens.

Note for future routes: the middleware infers success from the HTTP status
code. A route that answers 2xx while failing in business terms should set
`res.locals.auditSuccess = false` before responding. No current route does this.

Background grading jobs

Grading a lesson is a backend job, so the teacher can close the tab as soon as
it has started. The website calls `POST /grading-jobs` (202 + `jobId`), then
polls `GET /grading-jobs/:id` while it is open; `GET /grading-jobs/latest`
shows the last run of a class + lesson when the page is reopened. When the job
ends, the teacher gets a bell entry and a push.

- `lib/gradingJobs.js` — the job: create (one per class + lesson at a time),
  prepare (read every doc, grade the class in one deduped batch), write (one
  task per doc: write, then charge), finalize (summary, bell, push). Its header
  explains why each step is safe to run twice or concurrently.
- `lib/doc/` — the website's `docParser` / `docTableDetect` / `docTables` /
  `docWriter`, copied VERBATIM so both sides read and write docs identically.
  Edit them in the website repo, then `npm run sync:doc-lib`;
  `npm run check:doc-lib` and `tests/docLib.test.js` catch drift.
- `lib/googleUserToken.js` — the teacher's Google refresh token, stored
  AES-256-GCM encrypted (`GOOGLE_TOKEN_ENC_KEYS`), so docs are written as the
  teacher. Username/password accounts keep using the service account.
- `lib/taskQueue.js` — Cloud Tasks (`TASKS_MODE=cloud`) or in-process
  (`TASKS_MODE=inline`, local dev only: not durable).
- `lib/teacherPoints.js` — the per-doc ledger charge shared with
  `/teacher-points/consume`.

Setup (queue, IAM, secret) is in `DEPLOYMENT_GUIDE.md`, Step 5. Tests:
`tests/gradingJobs.test.js` runs every step against an in-memory Firestore with
real transaction semantics, including the races and crash windows.

Security note

- Do not commit `.env` with your OpenAI API key.
- This service is intended for local or trusted network use; add authentication if deploying.
