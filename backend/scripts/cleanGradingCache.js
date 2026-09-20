// Re-cleans every gradingCache record with the current cleaning rules
// (`cleanContent` in lib/gradingKey.js) and removes the duplicates it exposes.
//
// Records written before cleaning existed still carry "1." / "→" / a trailing
// "." in their question/answer, and are keyed on that raw text — so the
// grader (which now looks up the CLEANED text) can no longer find them. This
// script rewrites each record under its cleaned id; records that collapse onto
// the same id are merged: the highest hitCount wins (ties → newest), hitCounts
// are summed, the rest are deleted.
//
//   node scripts/cleanGradingCache.js --dry-run
//   node scripts/cleanGradingCache.js
//   node scripts/cleanGradingCache.js --database="(default)" --dry-run
//
// Safe to re-run: a second run finds nothing to change.
const { getDb } = require("../lib/firestore.js");
const { planCacheCleanup } = require("../lib/gradingKey.js");

const WRITE_CHUNK = 400; // Firestore batch limit is 500.
const SAMPLE_COUNT = 10;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbArg = args.find((a) => a.startsWith("--database="));
const databaseId = dbArg
  ? dbArg.slice("--database=".length)
  : process.env.FIRESTORE_DATABASE_ID || "(default)";

const oneLine = (s) => JSON.stringify(String(s ?? ""));

(async () => {
  console.log(
    `${dryRun ? "DRY RUN — no writes" : "APPLYING"} | database: ${databaseId}\n`,
  );

  const db = getDb(databaseId);
  const cacheRef = db.collection("gradingCache");
  const snap = await cacheRef.get();
  const docs = snap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const byId = new Map(docs.map((d) => [d.id, d.data]));

  const { writes, deletes, skipped } = planCacheCleanup(docs);
  const merged = writes.filter((w) => w.from.length > 1);

  console.log(`scanned          ${docs.length}`);
  console.log(`to rewrite       ${writes.length}`);
  console.log(
    `duplicate groups ${merged.length} (${merged.reduce((n, w) => n + w.from.length, 0)} records → ${merged.length})`,
  );
  console.log(`to delete        ${deletes.length}`);
  if (skipped.length) {
    console.log(
      `skipped          ${skipped.length} (empty after cleaning): ${skipped.map((s) => s.id).join(", ")}`,
    );
  }

  const samples = [...merged, ...writes.filter((w) => w.from.length === 1)];
  if (samples.length) console.log(`\nsamples (up to ${SAMPLE_COUNT}):`);
  samples.slice(0, SAMPLE_COUNT).forEach((w) => {
    console.log(`  → ${w.id}  hitCount=${w.data.hitCount}`);
    w.from.forEach((id) => {
      const old = byId.get(id) || {};
      console.log(
        `      ${id}  Q=${oneLine(old.question)}  A=${oneLine(old.answer)}`,
      );
    });
    console.log(
      `      cleaned  Q=${oneLine(w.data.question)}  A=${oneLine(w.data.answer)}`,
    );
  });

  if (dryRun || (writes.length === 0 && deletes.length === 0)) {
    console.log(
      `\n${dryRun ? "would change" : "changed"} ${writes.length + deletes.length} document(s)`,
    );
    process.exit(0);
  }

  // Writes first, deletes after: a run interrupted in between leaves extra
  // records (which a re-run removes), never lost feedback.
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const batch = db.batch();
    writes
      .slice(i, i + WRITE_CHUNK)
      .forEach((w) => batch.set(cacheRef.doc(w.id), w.data));
    await batch.commit();
  }
  for (let i = 0; i < deletes.length; i += WRITE_CHUNK) {
    const batch = db.batch();
    deletes
      .slice(i, i + WRITE_CHUNK)
      .forEach((id) => batch.delete(cacheRef.doc(id)));
    await batch.commit();
  }

  console.log(
    `\nwrote ${writes.length}, deleted ${deletes.length} document(s)`,
  );
  process.exit(0);
})().catch((err) => {
  console.error("clean failed:", err);
  process.exit(1);
});
