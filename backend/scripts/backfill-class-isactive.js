// One-time migration: set `isActive: true` on every `classes` doc that is
// missing the field. Safe to re-run (only touches docs without `isActive`).
//
// Usage (from the backend/ directory):
//   node scripts/backfill-class-isactive.js
//
// Uses the shared Firestore init (lib/firestore.js): targets the database in
// FIRESTORE_DATABASE_ID (e.g. run with FIRESTORE_DATABASE_ID=dev to backfill dev).
const { db } = require("../lib/firestore.js");

async function main() {
  const snapshot = await db.collection("classes").get();
  console.log(`Found ${snapshot.size} class document(s).`);

  const toUpdate = snapshot.docs.filter(
    (doc) => doc.data().isActive === undefined,
  );
  console.log(`${toUpdate.length} document(s) missing isActive.`);

  const CHUNK = 400; // < 500 per Firestore batch limit
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const batch = db.batch();
    toUpdate.slice(i, i + CHUNK).forEach((doc) => {
      batch.update(doc.ref, { isActive: true });
    });
    await batch.commit();
    updated += Math.min(CHUNK, toUpdate.length - i);
    console.log(`Updated ${updated}/${toUpdate.length}…`);
  }

  console.log(`Done. Backfilled isActive=true on ${updated} document(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
