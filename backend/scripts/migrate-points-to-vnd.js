/**
 * One-off migration: teacher balances from points to VND (lib/billing.js).
 *
 * Every TeacherPoint record without `balanceVnd` gets
 *   balanceVnd = round(point × 700)
 * and `migratedToVndAt`. `point` itself is left as it was, for the record —
 * once `balanceVnd` exists nothing reads `point` any more. Records that already
 * have `balanceVnd` are skipped, so re-running changes nothing.
 *
 * The backend converts lazily too (balanceVndOf: a record without balanceVnd
 * reads as point × 700, and its first charge/top-up stores it), so this script
 * is not a deploy prerequisite: it makes the stored data say what the screens
 * show. Each record is converted in its own transaction, so a charge landing
 * at the same moment is never lost.
 *
 * Revenue (AdminBilling/summary.totalTopUpVnd) needs no conversion: it already
 * held the admin's share (60.000đ per 100 points = 6/7 of the 70.000đ paid).
 *
 * Usage (from backend/):
 *   node scripts/migrate-points-to-vnd.js --db dev            # dry-run
 *   node scripts/migrate-points-to-vnd.js --db dev --apply
 *   node scripts/migrate-points-to-vnd.js --db prod --apply   # asks CONFIRM-PROD
 */
const readline = require("readline");

const { LEGACY_VND_PER_POINT, formatVnd } = require("../lib/billing.js");

const DB_ID = { dev: "auto-check-exer-dev", prod: "(default)" };

/** Pure: the conversion of one record, or null when it needs none. */
function planRecord(data) {
  if (!data || Number.isFinite(data.balanceVnd)) return null;
  const point = Number(data.point) || 0;
  return { point, balanceVnd: Math.round(point * LEGACY_VND_PER_POINT) };
}

function parseArgs(argv) {
  const args = { db: null, apply: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") args.db = argv[++i];
    else if (a === "--apply") args.apply = true;
    else if (a === "--yes") args.yes = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!DB_ID[args.db]) {
    console.error("--db must be 'dev' or 'prod'.");
    process.exit(1);
  }
  return args;
}

async function confirmProd() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) =>
    rl.question(
      "\n⚠️  This writes to the PRODUCTION database.\n" +
        "Type 'CONFIRM-PROD' to execute, anything else to cancel: ",
      resolve,
    ),
  );
  rl.close();
  if (answer.trim() !== "CONFIRM-PROD") {
    console.error("❌ Aborted.");
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { admin, getDb } = require("../lib/firestore.js");
  const db = getDb(DB_ID[args.db]);

  const snap = await db.collection("TeacherPoint").get();
  const todo = [];
  snap.forEach((doc) => {
    const plan = planRecord(doc.data());
    if (plan) todo.push({ id: doc.id, name: doc.data().name || "", ...plan });
  });

  console.log(`\nPoints → VND on ${args.db} (${DB_ID[args.db]})`);
  console.log(args.apply ? "Mode: APPLY" : "Mode: DRY-RUN (no writes)");
  console.log(
    `  ${snap.size} record(s), ${todo.length} to convert, ` +
      `${snap.size - todo.length} already in VND`,
  );
  for (const r of todo) {
    console.log(
      `  ${r.id} ${r.name}: ${r.point} point → ${formatVnd(r.balanceVnd)}`,
    );
  }

  if (!args.apply) {
    console.log("\n✅ Dry-run complete (re-run with --apply to write).");
    return;
  }
  if (args.db === "prod" && !args.yes) await confirmProd();

  let converted = 0;
  for (const r of todo) {
    const ref = db.collection("TeacherPoint").doc(r.id);
    const done = await db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      // Re-planned inside the transaction: a charge since the listing may
      // have converted it already, or moved `point`.
      const plan = current.exists ? planRecord(current.data()) : null;
      if (!plan) return false;
      tx.update(ref, {
        balanceVnd: plan.balanceVnd,
        migratedToVndAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (done) converted += 1;
  }
  console.log(`\n✅ Done: ${converted} record(s) converted.`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

module.exports = { planRecord };
