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

Retention is 30 days (`AUDIT_RETENTION_DAYS`). Each document carries an
`expireAt` timestamp; enable a **Firestore TTL policy** on
`auditLogs.expireAt` so Google deletes expired entries at no cost:

```bash
gcloud firestore fields ttls update expireAt \
  --collection-group=auditLogs --enable-ttl
```

Until that policy is enabled (or to clear a backlog immediately), run the
manual fallback:

```bash
node scripts/purgeAuditLogs.js --dry-run   # count only
node scripts/purgeAuditLogs.js             # delete
```

Note for future routes: the middleware infers success from the HTTP status
code. A route that answers 2xx while failing in business terms should set
`res.locals.auditSuccess = false` before responding. No current route does this.

Security note

- Do not commit `.env` with your OpenAI API key.
- This service is intended for local or trusted network use; add authentication if deploying.
