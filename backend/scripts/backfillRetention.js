// Re-stamps `expireAt` on existing documents after a retention window changes.
//
// AUDIT_RETENTION_DAYS / NOTIFICATION_RETENTION_DAYS are applied by the writer
// at insert time, so changing them only affects NEW documents — everything
// already stored keeps the expiry it was born with. This script realigns the
// existing rows with the current constants.
//
// Recomputes expireAt = createdAt + <current retention>, per collection, on the
// database selected by FIRESTORE_DATABASE_ID (or --database).
//
//   node scripts/backfillRetention.js --dry-run
//   node scripts/backfillRetention.js
//   node scripts/backfillRetention.js --database="(default)" --dry-run
//
// Safe to re-run: it is idempotent, and skips documents already correct.
const { admin, getDb } = require("../lib/firestore.js");
const { AUDIT_RETENTION_DAYS } = require("../lib/auditLog.js");
const { NOTIFICATION_RETENTION_DAYS } = require("../lib/notifications.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const WRITE_CHUNK = 400;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbArg = args.find((a) => a.startsWith("--database="));
const databaseId = dbArg
  ? dbArg.slice("--database=".length)
  : process.env.FIRESTORE_DATABASE_ID || "(default)";

const TARGETS = [
  { collection: "auditLogs", days: AUDIT_RETENTION_DAYS },
  { collection: "notifications", days: NOTIFICATION_RETENTION_DAYS },
];

async function backfill(db, collection, days) {
  const snap = await db.collection(collection).get();
  if (snap.empty) {
    console.log(`  ${collection.padEnd(14)} (empty)`);
    return { scanned: 0, changed: 0 };
  }

  const updates = [];
  let noCreatedAt = 0;
  let alreadyCorrect = 0;

  snap.forEach((doc) => {
    const data = doc.data() || {};
    const createdAt = data.createdAt;
    if (!createdAt || !createdAt.toMillis) {
      // Without a createdAt there is no defensible new expiry — leave it alone
      // rather than inventing one from "now" and silently extending its life.
      noCreatedAt++;
      return;
    }
    const wantMs = createdAt.toMillis() + days * DAY_MS;
    const haveMs = data.expireAt?.toMillis?.() ?? null;
    // Tolerate sub-second drift so a re-run is a no-op.
    if (haveMs !== null && Math.abs(haveMs - wantMs) < 1000) {
      alreadyCorrect++;
      return;
    }
    updates.push({
      ref: doc.ref,
      from: haveMs,
      to: wantMs,
      expireAt: admin.firestore.Timestamp.fromMillis(wantMs),
    });
  });

  const iso = (ms) =>
    ms === null ? "—" : new Date(ms).toISOString().slice(0, 10);
  const extended = updates.filter(
    (u) => u.from !== null && u.to > u.from,
  ).length;
  const shortened = updates.filter(
    (u) => u.from !== null && u.to < u.from,
  ).length;

  console.log(
    `  ${collection.padEnd(14)} scanned=${String(snap.size).padStart(4)}` +
      `  to change=${String(updates.length).padStart(4)}` +
      `  (extended ${extended}, shortened ${shortened})` +
      `  already ok=${alreadyCorrect}` +
      (noCreatedAt ? `  no createdAt=${noCreatedAt} (skipped)` : ""),
  );
  if (updates.length > 0) {
    const froms = updates.map((u) => u.from).filter((v) => v !== null);
    const tos = updates.map((u) => u.to);
    console.log(
      `                 expireAt ${iso(Math.min(...froms))}..${iso(Math.max(...froms))}` +
        ` -> ${iso(Math.min(...tos))}..${iso(Math.max(...tos))} (+${days}d from createdAt)`,
    );
  }

  if (dryRun || updates.length === 0) {
    // Report the would-be count either way, so the dry-run total matches the
    // per-collection lines above instead of always saying 0.
    return { scanned: snap.size, changed: updates.length };
  }

  for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
    const batch = db.batch();
    updates
      .slice(i, i + WRITE_CHUNK)
      .forEach((u) => batch.update(u.ref, { expireAt: u.expireAt }));
    await batch.commit();
  }
  return { scanned: snap.size, changed: updates.length };
}

(async () => {
  console.log(
    `${dryRun ? "DRY RUN — no writes" : "APPLYING"} | database: ${databaseId}`,
  );
  console.log(
    `retention: auditLogs=${AUDIT_RETENTION_DAYS}d, notifications=${NOTIFICATION_RETENTION_DAYS}d\n`,
  );

  const db = getDb(databaseId);
  let totalChanged = 0;
  for (const { collection, days } of TARGETS) {
    const { changed } = await backfill(db, collection, days);
    totalChanged += changed;
  }

  console.log(
    `\n${dryRun ? "would update" : "updated"} ${totalChanged} document(s)`,
  );
  process.exit(0);
})().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
