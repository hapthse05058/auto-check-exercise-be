// One-time migration: set `isAccountActive: true` on every `teachers` doc that is
// missing the field. Safe to re-run (only touches docs without `isAccountActive`).
//
// Usage (from the backend/ directory):
//   node scripts/backfill-teacher-isaccountactive.js
//
// Mirrors server.js firebase-admin init: in production the service account is
// mounted at /secrets/firebase-service-account, locally it lives one level up.
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const serviceAccountPath =
  process.env.NODE_ENV === "production"
    ? "/secrets/firebase-service-account"
    : path.join(__dirname, "..", "firebase-service-account.json");

if (!fs.existsSync(serviceAccountPath)) {
  console.error(`Service account file not found at: ${serviceAccountPath}`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccountPath),
});

const db = admin.firestore();

async function main() {
  const snapshot = await db.collection("teachers").get();
  console.log(`Found ${snapshot.size} teacher document(s).`);

  const toUpdate = snapshot.docs.filter(
    (doc) => doc.data().isAccountActive === undefined,
  );
  console.log(`${toUpdate.length} document(s) missing isAccountActive.`);

  const CHUNK = 400; // < 500 per Firestore batch limit
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const batch = db.batch();
    toUpdate.slice(i, i + CHUNK).forEach((doc) => {
      batch.update(doc.ref, { isAccountActive: true });
    });
    await batch.commit();
    updated += Math.min(CHUNK, toUpdate.length - i);
    console.log(`Updated ${updated}/${toUpdate.length}…`);
  }

  console.log(`Done. Backfilled isAccountActive=true on ${updated} document(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
