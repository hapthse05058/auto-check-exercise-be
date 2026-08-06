// Deletes expired `auditLogs` documents (expireAt < now).
//
// A Firestore TTL policy on auditLogs.expireAt does this automatically and for
// free — see the "Audit log" section of README.md. This script is the manual
// fallback for projects where the TTL policy has not been enabled yet, or to
// clear a backlog immediately instead of waiting for the TTL sweep.
//
// Usage (from the backend/ directory):
//   node scripts/purgeAuditLogs.js --dry-run   # count only, deletes nothing
//   node scripts/purgeAuditLogs.js             # actually delete
//
// Uses the shared Firestore init (lib/firestore.js): targets the database in
// FIRESTORE_DATABASE_ID.
const { admin, db } = require("../lib/firestore.js");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const now = admin.firestore.Timestamp.now();
  const snapshot = await db
    .collection("auditLogs")
    .where("expireAt", "<", now)
    .get();

  console.log(`Found ${snapshot.size} expired audit log document(s).`);
  if (snapshot.empty) return;

  if (dryRun) {
    const oldest = snapshot.docs[0]?.data();
    console.log("Dry run — nothing deleted.");
    console.log(
      `Oldest expired entry: ${oldest?.action ?? "?"} by ${oldest?.actorEmail ?? "?"}`,
    );
    return;
  }

  const CHUNK = 400; // < 500 per Firestore batch limit
  let deleted = 0;
  for (let i = 0; i < snapshot.docs.length; i += CHUNK) {
    const batch = db.batch();
    snapshot.docs.slice(i, i + CHUNK).forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += Math.min(CHUNK, snapshot.docs.length - i);
    console.log(`Deleted ${deleted}/${snapshot.size}…`);
  }

  console.log(`Done. Purged ${deleted} expired audit log document(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Purge failed:", err);
    process.exit(1);
  });
