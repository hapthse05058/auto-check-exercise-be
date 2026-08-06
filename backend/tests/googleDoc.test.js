const assert = require("node:assert/strict");
const { test } = require("node:test");

const { extractDocId, findDuplicateDocs } = require("../lib/googleDoc.js");

const DOC = "https://docs.google.com/document/d/abc";
const DOC2 = "https://docs.google.com/document/d/def";

test("extractDocId: ignores tab id and any URL suffix", () => {
  assert.equal(extractDocId(DOC), "abc");
  assert.equal(extractDocId(`${DOC}/edit?tab=t.a1b2&usp=sharing`), "abc");
  assert.equal(extractDocId("https://example.com/x"), "");
  assert.equal(extractDocId(undefined), "");
  assert.equal(extractDocId(null), "");
});

test("findDuplicateDocs: no clash for distinct docs", () => {
  const found = findDuplicateDocs(
    [{ name: "A", ggDocLink: DOC }],
    [{ name: "B", ggDocLink: DOC2 }],
  );
  assert.deepEqual(found, []);
});

test("findDuplicateDocs: same doc already in the class", () => {
  const found = findDuplicateDocs(
    [{ name: "New", ggDocLink: `${DOC}/edit?tab=t.0` }],
    [{ name: "Saved", ggDocLink: DOC }],
  );
  assert.deepEqual(found, [{ docId: "abc", names: ["Saved", "New"] }]);
});

test("findDuplicateDocs: same doc twice inside one payload", () => {
  const found = findDuplicateDocs([
    { name: "A", ggDocLink: DOC },
    { name: "B", ggDocLink: DOC },
    { name: "C", ggDocLink: DOC },
  ]);
  assert.deepEqual(found, [{ docId: "abc", names: ["A", "B", "C"] }]);
});

test("findDuplicateDocs: a repeated name is listed once", () => {
  const found = findDuplicateDocs([
    { name: "A", ggDocLink: DOC },
    { name: "A", ggDocLink: DOC },
  ]);
  assert.deepEqual(found, [{ docId: "abc", names: ["A"] }]);
});

test("findDuplicateDocs: links without a doc id are left alone", () => {
  const found = findDuplicateDocs(
    [
      { name: "A", ggDocLink: "" },
      { name: "B", ggDocLink: "not-a-doc" },
    ],
    [{ name: "C", ggDocLink: "" }],
  );
  assert.deepEqual(found, []);
});
