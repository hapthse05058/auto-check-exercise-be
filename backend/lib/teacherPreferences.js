// A teacher's own UI preferences (stored on the teacher doc as `preferences`),
// so they follow the account to any device. Pure validation, no Firestore/IO,
// so it can be unit-tested directly (see backend/tests/teacherPreferences.test.js).

/** Every preference a client may set, with the values it accepts. */
const ALLOWED = {
  theme: ["light", "dark"],
};

/**
 * Validates a PATCH /teacher-info/preferences body.
 * Returns { preferences } holding only the keys that were sent, or { error }.
 * Unknown keys are rejected rather than ignored, so a typo is not a silent no-op.
 */
function parsePreferences(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be a JSON object" };
  }
  const unknown = Object.keys(body).filter((key) => !(key in ALLOWED));
  if (unknown.length) {
    return { error: `Unknown preference: ${unknown.join(", ")}` };
  }
  const preferences = {};
  for (const [key, values] of Object.entries(ALLOWED)) {
    if (!(key in body)) continue;
    if (!values.includes(body[key])) {
      return { error: `${key} must be one of: ${values.join(", ")}` };
    }
    preferences[key] = body[key];
  }
  if (!Object.keys(preferences).length) {
    return { error: "No preference to update" };
  }
  return { preferences };
}

/** Firestore dotted-path update, so other stored preferences are kept. */
function toFirestoreUpdate(preferences) {
  return Object.fromEntries(
    Object.entries(preferences).map(([key, value]) => [
      `preferences.${key}`,
      value,
    ]),
  );
}

module.exports = { ALLOWED, parsePreferences, toFirestoreUpdate };
