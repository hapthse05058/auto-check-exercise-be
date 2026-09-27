const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const WEBSITE_LIB = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "auto-check-exercise-website",
  "src",
  "lib",
);
const FILES = [
  "docParser.js",
  "docTableDetect.js",
  "docTables.js",
  "docWriter.js",
  "ieltsDoc.js",
  "hsDoc.js",
  "hsTemplate.js",
];
const normalize = (text) => text.replace(/\r\n/g, "\n");

describe("lib/doc", () => {
  // The whole point of lib/doc is being the website's code, byte for byte —
  // that is what makes its (much larger) test suite cover the backend too.
  it(
    "is identical to the website's modules",
    { skip: !fs.existsSync(WEBSITE_LIB) && "website repo not checked out" },
    () => {
      for (const file of FILES) {
        assert.equal(
          normalize(
            fs.readFileSync(
              path.join(__dirname, "..", "lib", "doc", file),
              "utf8",
            ),
          ),
          normalize(fs.readFileSync(path.join(WEBSITE_LIB, file), "utf8")),
          `${file} drifted — run: npm run sync:doc-lib`,
        );
      }
    },
  );

  it("loads from CommonJS and reads a lesson tab end to end", async () => {
    const lib = Object.assign(
      {},
      await import("../lib/doc/docParser.js"),
      await import("../lib/doc/docTableDetect.js"),
      await import("../lib/doc/docWriter.js"),
    );
    const { makeTab } = require("./helpers/gradingHarness.js");
    const tab = makeTab({ answers: ["I go school"] });
    const { rows } = lib.collectExerciseRows(tab, "basic_since_01042026");
    const qa = lib.getQuesAndAnsFromRows(rows);
    assert.equal(qa.length, 1);
    assert.equal(qa[0].answer, "→ I go school");

    const requests = lib.buildFeedbackRequests(
      [
        {
          rowKey: `${qa[0].tableIdx}:${qa[0].rowIdx}`,
          aiFeedback: "I go to school.",
        },
      ],
      rows,
      "t.x",
    );
    const inserted = requests
      .filter((r) => r.insertText)
      .map((r) => r.insertText.text);
    assert.ok(inserted.includes("I go to school."));
  });
});
