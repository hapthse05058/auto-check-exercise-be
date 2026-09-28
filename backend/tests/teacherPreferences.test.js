const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  parsePreferences,
  toFirestoreUpdate,
} = require("../lib/teacherPreferences.js");

test("parsePreferences: accepts each theme", () => {
  assert.deepEqual(parsePreferences({ theme: "dark" }), {
    preferences: { theme: "dark" },
  });
  assert.deepEqual(parsePreferences({ theme: "light" }), {
    preferences: { theme: "light" },
  });
});

test("parsePreferences: rejects a bad theme value", () => {
  assert.match(parsePreferences({ theme: "blue" }).error, /theme must be/);
  assert.match(parsePreferences({ theme: null }).error, /theme must be/);
  assert.match(parsePreferences({ theme: "DARK" }).error, /theme must be/);
});

test("parsePreferences: rejects unknown keys instead of ignoring them", () => {
  const { error } = parsePreferences({ theme: "dark", isAdmin: true });
  assert.match(error, /Unknown preference: isAdmin/);
});

test("parsePreferences: rejects an empty or non-object body", () => {
  assert.match(parsePreferences({}).error, /No preference/);
  assert.match(parsePreferences(null).error, /JSON object/);
  assert.match(parsePreferences(["dark"]).error, /JSON object/);
  assert.match(parsePreferences("dark").error, /JSON object/);
});

test("toFirestoreUpdate: writes dotted paths so other preferences survive", () => {
  assert.deepEqual(toFirestoreUpdate({ theme: "dark" }), {
    "preferences.theme": "dark",
  });
});
