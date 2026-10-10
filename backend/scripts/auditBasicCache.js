// Finds Basic gradingCache records whose correction cannot belong to their
// answer — feedback filed under the wrong item by the old renumbering bug
// (lib/basicRows.js) — and deletes ONLY the ids a person has reviewed.
//
//   node scripts/auditBasicCache.js --database="(default)" --out=suspects.json
//       dry run: prints every suspect with its reason, writes them to --out
//   node scripts/auditBasicCache.js --database="(default)" --apply --keys=ids.txt
//       deletes the ids listed in ids.txt (one per line, or a JSON array of
//       ids / of suspect objects), and only those still failing the check;
//       every deleted id is printed and appended to ids.txt.deleted.log
//
// Never deletes on its own judgement: without --apply --keys nothing is
// written. Paragraph records and records with a missing field are reported
// apart, never as suspects. Deleting a record does not fix a doc it was
// already written into: those need "Xóa feedback" and a new grading run.
const fs = require("fs");

const { getDb } = require("../lib/firestore.js");
const { correctionFitsAnswer } = require("../lib/basicRows.js");

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const apply = args.includes("--apply");
const keysFile = flag("keys");
const outFile = flag("out");
const databaseId =
  flag("database") || process.env.FIRESTORE_DATABASE_ID || "(default)";

const oneLine = (s) => JSON.stringify(String(s ?? ""));

/** "suspect" | "incomplete" | "paragraph" | "ok" for one cache record. */
function classify(data) {
  if (!data) return "incomplete";
  if (data.taskType === "paragraph") return "paragraph";
  if (!data.question || !data.answer || !data.feedback) return "incomplete";
  return correctionFitsAnswer(data.feedback, data.answer) ? "ok" : "suspect";
}

function readKeys(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (text.startsWith("[")) {
    return JSON.parse(text).map((k) => (typeof k === "string" ? k : k.id));
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

(async () => {
  const db = getDb(databaseId);
  const cacheRef = db.collection("gradingCache");

  if (apply) {
    if (!keysFile)
      throw new Error("--apply needs --keys=<file of reviewed ids>");
    const keys = [...new Set(readKeys(keysFile))];
    console.log(`APPLYING | database: ${databaseId} | ${keys.length} id(s)\n`);
    const log = `${keysFile}.deleted.log`;
    let deleted = 0;
    for (const id of keys) {
      const snap = await cacheRef.doc(id).get();
      const verdict = snap.exists ? classify(snap.data()) : "missing";
      if (verdict !== "suspect") {
        console.log(`skip   ${id} (${verdict})`);
        continue;
      }
      await cacheRef.doc(id).delete();
      fs.appendFileSync(log, `${new Date().toISOString()} ${id}\n`);
      console.log(`delete ${id}`);
      deleted++;
    }
    console.log(`\ndeleted ${deleted} of ${keys.length}; log: ${log}`);
    process.exit(0);
  }

  console.log(`DRY RUN — no writes | database: ${databaseId}\n`);
  const snap = await cacheRef.get();
  const counts = { ok: 0, suspect: 0, incomplete: 0, paragraph: 0 };
  const suspects = [];
  const incomplete = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const verdict = classify(data);
    counts[verdict]++;
    const row = {
      id: doc.id,
      reason:
        verdict === "suspect"
          ? "correction shares no words with answer"
          : verdict,
      question: data?.question ?? null,
      answer: data?.answer ?? null,
      feedback: data?.feedback ?? null,
      promptVersion: data?.promptVersion ?? null,
      model: data?.model ?? null,
      hitCount: data?.hitCount ?? 0,
    };
    if (verdict === "suspect") suspects.push(row);
    if (verdict === "incomplete") incomplete.push(row);
  }

  console.log(`scanned     ${snap.size}`);
  console.log(`ok          ${counts.ok}`);
  console.log(`paragraph   ${counts.paragraph} (not checked)`);
  console.log(
    `incomplete  ${counts.incomplete} (missing a field, not suspects)`,
  );
  console.log(`suspects    ${counts.suspect}\n`);
  for (const s of suspects) {
    console.log(`${s.id}  hit=${s.hitCount}  ${s.promptVersion}/${s.model}`);
    console.log(`   Q  ${oneLine(s.question)}`);
    console.log(`   A  ${oneLine(s.answer)}`);
    console.log(`   FB ${oneLine(s.feedback)}`);
  }
  if (incomplete.length) {
    console.log(`\nincomplete ids: ${incomplete.map((r) => r.id).join(", ")}`);
  }
  if (outFile) {
    fs.writeFileSync(outFile, `${JSON.stringify(suspects, null, 2)}\n`);
    console.log(`\nwrote ${suspects.length} suspect(s) to ${outFile}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
