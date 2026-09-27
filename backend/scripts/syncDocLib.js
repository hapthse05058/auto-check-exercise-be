/**
 * Copies the website's pure doc modules into lib/doc/, byte for byte.
 *
 * The backend writes grading feedback into Google Docs with the SAME code the
 * website used to run in the browser, so both sides find the same tables, read
 * the same answers and write the same text. The website is the source of truth:
 * edit there, then run this.
 *
 *   node scripts/syncDocLib.js            copy
 *   node scripts/syncDocLib.js --check    exit 1 when lib/doc/ has drifted
 *   node scripts/syncDocLib.js --from <website src/lib dir>
 */
const fs = require("fs");
const path = require("path");

const FILES = [
  "docParser.js",
  "docTableDetect.js",
  "docTables.js",
  "docWriter.js",
  "ieltsDoc.js",
];
const TARGET = path.join(__dirname, "..", "lib", "doc");
const DEFAULT_SOURCE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "auto-check-exercise-website",
  "src",
  "lib",
);

/** Line endings differ between checkouts; the content is what must match. */
const normalize = (text) => text.replace(/\r\n/g, "\n");

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const fromAt = args.indexOf("--from");
  const source =
    fromAt === -1 ? DEFAULT_SOURCE : path.resolve(args[fromAt + 1]);

  if (!fs.existsSync(source)) {
    console.error(`Website lib not found: ${source} (pass --from <dir>)`);
    process.exit(2);
  }

  const drifted = [];
  for (const file of FILES) {
    const wanted = normalize(fs.readFileSync(path.join(source, file), "utf8"));
    const targetPath = path.join(TARGET, file);
    const current = fs.existsSync(targetPath)
      ? normalize(fs.readFileSync(targetPath, "utf8"))
      : null;
    if (current === wanted) continue;
    drifted.push(file);
    if (!check) fs.writeFileSync(targetPath, wanted);
  }

  if (check) {
    if (drifted.length) {
      console.error(`lib/doc/ is out of sync: ${drifted.join(", ")}`);
      console.error("Run: npm run sync:doc-lib");
      process.exit(1);
    }
    console.log("lib/doc/ is in sync with the website.");
    return;
  }
  console.log(
    drifted.length ? `Updated: ${drifted.join(", ")}` : "Already in sync.",
  );
}

main();
