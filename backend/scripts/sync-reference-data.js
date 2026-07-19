/**
 * Sync REFERENCE / CONFIG collections between the dev and prod Firestore
 * databases (same GCP project). Transactional/user data is NEVER touched.
 *
 * Usage (from the backend/ directory):
 *   node scripts/sync-reference-data.js [options]
 *
 * Options:
 *   --from <dev|prod>   source database      (default: dev)
 *   --to   <dev|prod>   target database      (default: prod)
 *   --apply             actually write       (default: DRY-RUN — nothing is written)
 *   --include-cache     also sync gradingCache (off by default)
 *   --include-drafts    also copy docs marked draft/inactive (off by default)
 *   --prune             delete target docs whose id is absent in source (off by default)
 *   --yes               skip the interactive CONFIRM-PROD prompt (for CI)
 *
 * Examples:
 *   # Seed the dev DB from prod's reference data:
 *   node scripts/sync-reference-data.js --from prod --to dev --apply
 *   # Promote dev reference changes to prod (interactive guard, then write):
 *   node scripts/sync-reference-data.js --from dev --to prod --apply
 *   # CI promotion (non-interactive):
 *   node scripts/sync-reference-data.js --from dev --to prod --apply --yes
 */
const readline = require("readline");
const { getDb } = require("../lib/firestore.js");

// Collections that are safe to promote. gradingCache is opt-in (--include-cache).
const ALLOWED = ["classType", "lesson"];
const CACHE = "gradingCache";
// Never read or write these — real per-environment user data.
const FORBIDDEN = new Set([
  "teachers",
  "classes",
  "students",
  "students-testing-table",
  "TeacherPoint",
  "AdminBilling",
]);

const DB_ID = { dev: "auto-check-exer-dev", prod: "(default)" };

function parseArgs(argv) {
  const args = {
    from: "dev",
    to: "prod",
    apply: false,
    includeCache: false,
    includeDrafts: false,
    prune: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--apply") args.apply = true;
    else if (a === "--include-cache") args.includeCache = true;
    else if (a === "--include-drafts") args.includeDrafts = true;
    else if (a === "--prune") args.prune = true;
    else if (a === "--yes") args.yes = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!DB_ID[args.from] || !DB_ID[args.to]) {
    console.error("--from / --to must each be 'dev' or 'prod'.");
    process.exit(1);
  }
  if (args.from === args.to) {
    console.error("--from and --to must differ.");
    process.exit(1);
  }
  return args;
}

/** Blocks until the operator types CONFIRM-PROD when writing to prod (unless --yes). */
async function checkGuard(toEnv, apply, hasYesFlag) {
  if (toEnv !== "prod" || !apply) return true; // dry-run / writing to dev → no prompt
  if (hasYesFlag) {
    console.log("⚠️  --yes: proceeding with PRODUCTION sync (CI mode).");
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(
      "\n⚠️  You are about to write DIRECTLY into the PRODUCTION database.\n" +
        "Type 'CONFIRM-PROD' to execute, anything else to cancel: ",
      (answer) => {
        rl.close();
        if (answer.trim() === "CONFIRM-PROD") resolve(true);
        else {
          console.error("❌ Aborted by user.");
          process.exit(1);
        }
      },
    );
  });
}

/** A doc is "publishable" unless explicitly marked draft/inactive. Absent flags → included. */
function isPublishable(data) {
  if (data.status === "draft") return false;
  if (data.isActive === false) return false;
  if (data.published === false) return false;
  return true;
}

async function syncCollection(name, srcDb, dstDb, opts) {
  if (FORBIDDEN.has(name)) {
    throw new Error(`Refusing to sync forbidden collection: ${name}`);
  }
  const srcSnap = await srcDb.collection(name).get();
  let srcDocs = srcSnap.docs;
  const skippedDrafts = !opts.includeDrafts
    ? srcDocs.filter((d) => !isPublishable(d.data())).length
    : 0;
  if (!opts.includeDrafts)
    srcDocs = srcDocs.filter((d) => isPublishable(d.data()));

  const dstSnap = await dstDb.collection(name).get();
  const dstIds = new Set(dstSnap.docs.map((d) => d.id));
  const srcIds = new Set(srcDocs.map((d) => d.id));

  const toAdd = srcDocs.filter((d) => !dstIds.has(d.id)).length;
  const toUpdate = srcDocs.filter((d) => dstIds.has(d.id)).length;
  const toPrune = opts.prune ? [...dstIds].filter((id) => !srcIds.has(id)) : [];

  console.log(
    `  ${name}: ${srcDocs.length} source doc(s) → add ${toAdd}, update ${toUpdate}` +
      (skippedDrafts ? `, skipped ${skippedDrafts} draft/inactive` : "") +
      (opts.prune ? `, prune ${toPrune.length}` : ""),
  );

  if (!opts.apply) return;

  const CHUNK = 400; // < 500 per Firestore batch limit
  const writes = srcDocs.map((d) => ({
    ref: dstDb.collection(name).doc(d.id),
    data: d.data(),
  }));
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = dstDb.batch();
    writes.slice(i, i + CHUNK).forEach((w) => batch.set(w.ref, w.data));
    await batch.commit();
  }
  for (let i = 0; i < toPrune.length; i += CHUNK) {
    const batch = dstDb.batch();
    toPrune
      .slice(i, i + CHUNK)
      .forEach((id) => batch.delete(dstDb.collection(name).doc(id)));
    await batch.commit();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const collections = [...ALLOWED, ...(opts.includeCache ? [CACHE] : [])];
  const srcDb = getDb(DB_ID[opts.from]);
  const dstDb = getDb(DB_ID[opts.to]);

  console.log(
    `\nSync reference data: ${opts.from} (${DB_ID[opts.from]}) → ${opts.to} (${DB_ID[opts.to]})`,
  );
  console.log(`Collections: ${collections.join(", ")}`);
  console.log(
    opts.apply ? "Mode: APPLY (will write)" : "Mode: DRY-RUN (no writes)",
  );

  await checkGuard(opts.to, opts.apply, opts.yes);

  for (const name of collections) {
    await syncCollection(name, srcDb, dstDb, opts);
  }

  console.log(
    opts.apply
      ? "\n✅ Done."
      : "\n✅ Dry-run complete (re-run with --apply to write).",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Sync failed:", err);
    process.exit(1);
  });
