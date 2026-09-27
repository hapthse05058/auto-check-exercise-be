/**
 * Seeds the HS course (course gradingProfile "hs", lib/hsGrading.js):
 *   1. the 26 lessons, ids = the HS form's canonical ids (lib/doc/hsTemplate.js):
 *      lesson/hsLesson01..hsLesson24 ("Buổi 01".."Buổi 24") and
 *      lesson/hsReview1, hsReview2 ("Ôn tập thêm 1", "Ôn tập thêm 2");
 *   2. the doc template teachers pick when creating an HS class:
 *      classType/hs_24buoi {code, name, gradingProfile: "hs"};
 *   3. the course, id `hs`, holding the 26 lessons in order.
 * Nothing that already exists is touched — re-running changes nothing.
 *
 * Run it only AFTER a backend that knows the "hs" profile is deployed: an
 * older backend would grade an HS course as Basic.
 *
 * Usage (from backend/):
 *   node scripts/seed-hs.js --db dev            # dry-run
 *   node scripts/seed-hs.js --db dev --apply
 *   node scripts/seed-hs.js --db prod --apply   # asks CONFIRM-PROD
 */
const readline = require("readline");

const { GRADING_PROFILE_HS, sortLessons } = require("../lib/courses.js");

const DB_ID = { dev: "auto-check-exer-dev", prod: "(default)" };
const HS_COURSE_ID = "hs";
const HS_TEMPLATE_CODE = "hs_24buoi";

/** The HS form's lessons, in course order: [{id, name}]. */
async function hsLessons() {
  const { HS_LESSONS } = await import("../lib/doc/hsTemplate.js");
  return HS_LESSONS.map((l) => ({ id: l.id, name: l.title }));
}

/**
 * Pure: what to create, given what exists.
 * @param {{lessons: Array<{id, name}>, existing: {lessons: Set<string>,
 *          templates: Set<string>, courses: Set<string>}, now: number}} input
 */
function planSeed({ lessons, existing, now }) {
  const writes = [];
  for (const lesson of lessons) {
    if (existing.lessons.has(lesson.id)) continue;
    writes.push({
      collection: "lesson",
      id: lesson.id,
      data: { name: lesson.name, classType: [HS_TEMPLATE_CODE] },
    });
  }
  if (!existing.templates.has(HS_TEMPLATE_CODE)) {
    writes.push({
      collection: "classType",
      id: HS_TEMPLATE_CODE,
      data: {
        code: HS_TEMPLATE_CODE,
        name: "HS – 24 buổi (cấp 1–2)",
        gradingProfile: GRADING_PROFILE_HS,
      },
    });
  }
  if (!existing.courses.has(HS_COURSE_ID)) {
    writes.push({
      collection: "courses",
      id: HS_COURSE_ID,
      data: {
        name: "HS (cấp 1–2)",
        lessonIds: sortLessons(lessons).map((l) => l.id),
        gradingProfile: GRADING_PROFILE_HS,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  return writes;
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
  const { getDb } = require("../lib/firestore.js");
  const db = getDb(DB_ID[args.db]);
  const lessons = await hsLessons();
  const ids = async (col, list) => {
    const snaps = await db.getAll(
      ...list.map((id) => db.collection(col).doc(id)),
    );
    return new Set(snaps.filter((s) => s.exists).map((s) => s.id));
  };
  const writes = planSeed({
    lessons,
    existing: {
      lessons: await ids(
        "lesson",
        lessons.map((l) => l.id),
      ),
      templates: await ids("classType", [HS_TEMPLATE_CODE]),
      courses: await ids("courses", [HS_COURSE_ID]),
    },
    now: Date.now(),
  });

  console.log(`\nSeed the HS course on ${args.db} (${DB_ID[args.db]})`);
  console.log(args.apply ? "Mode: APPLY" : "Mode: DRY-RUN (no writes)");
  for (const w of writes) console.log(`  + ${w.collection}/${w.id}`);
  if (!writes.length) console.log("  (everything already exists)");

  if (!args.apply || !writes.length) {
    console.log(
      args.apply
        ? "\n✅ Nothing to do."
        : "\n✅ Dry-run complete (re-run with --apply to write).",
    );
    return;
  }
  if (args.db === "prod" && !args.yes) await confirmProd();

  // Lessons and template first: a course must never list a missing lesson.
  const batch = db.batch();
  for (const w of writes) {
    batch.create(db.collection(w.collection).doc(w.id), w.data);
  }
  await batch.commit();
  console.log("\n✅ Done.");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}

module.exports = {
  HS_COURSE_ID,
  HS_TEMPLATE_CODE,
  hsLessons,
  planSeed,
};
