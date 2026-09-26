/**
 * Server-side Google Docs API calls for grading jobs. The backend twin of the
 * website's src/api/googleDocs.js — same endpoints, same header rule — plus
 * the one thing a background writer needs that the browser never did: telling
 * a failure worth retrying apart from one that will fail the same way forever.
 */

const DOCS_API = "https://docs.googleapis.com/v1/documents";
// Quota project for end-user (Gmail) tokens. The service-account token 403s
// with it, so it is only sent for user tokens (same rule as the website).
const PROJECT_NUMBER = process.env.GOOGLE_PROJECT_NUMBER || "159733287448";

/**
 * What the caller should do about a failed Docs API call:
 *   - "auth"        401 — the Google token is no longer accepted
 *   - "forbidden"   403 — the doc is not shared with this identity
 *   - "not_found"   404 — the doc is gone (or the id is wrong)
 *   - "bad_request" 400 — the request itself was refused; see writeDoc for how
 *                         a revision conflict is told apart from a real bug
 *   - "transient"   429, 5xx, network — retry later
 */
class DocsApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "DocsApiError";
    this.status = status;
    this.kind = classifyStatus(status);
  }
}

function classifyStatus(status) {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "bad_request";
  return "transient";
}

async function call(url, init) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    // DNS, reset, timeout: nothing reached Google, so trying again is safe.
    throw new DocsApiError(0, `network error: ${err.message}`);
  }
  if (response.ok) return response.json();
  // Google's error body names the problem; the token is never part of it.
  const body = await response.json().catch(() => null);
  throw new DocsApiError(
    response.status,
    body?.error?.message || `HTTP ${response.status}`,
  );
}

/** The whole document with every tab's content, and its current revisionId. */
function getDocument(docId, accessToken) {
  return call(
    `${DOCS_API}/${encodeURIComponent(docId)}?includeTabsContent=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
}

/** Only the current revisionId — used to classify a refused write. */
async function getRevisionId(docId, accessToken) {
  const doc = await call(
    `${DOCS_API}/${encodeURIComponent(docId)}?fields=revisionId`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return doc.revisionId;
}

/**
 * batchUpdate guarded by `requiredRevisionId`: Google applies it ONLY if the
 * doc is still at the revision the requests were computed from, and applies
 * all of it or none of it. That is what makes a duplicated or retried write
 * safe — a second writer always sees the doc moved and is refused.
 *
 * @returns {Promise<string|undefined>} the doc's revision after the write
 */
async function batchUpdate(
  docId,
  requests,
  accessToken,
  { requiredRevisionId, isServiceAccount = false } = {},
) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (!isServiceAccount) headers["x-goog-user-project"] = PROJECT_NUMBER;
  const body = { requests };
  if (requiredRevisionId) body.writeControl = { requiredRevisionId };
  const result = await call(
    `${DOCS_API}/${encodeURIComponent(docId)}:batchUpdate`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  return result?.writeControl?.requiredRevisionId;
}

module.exports = {
  DocsApiError,
  batchUpdate,
  classifyStatus,
  getDocument,
  getRevisionId,
};
