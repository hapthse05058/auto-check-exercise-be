/**
 * One-off migration to courses (lib/courses.js).
 *
 * Before courses, `classes.classType` held the student-doc template
 * (`basic_since_01042026`, …) and each lesson listed its templates in
 * `lesson.classType`. Every existing class is a Basic class, so this script:
 *   1. creates ONE course, id `basic`, named "Basic", holding every lesson any
 *      old template listed (skipped when it already exists — re-running
 *      changes nothing);
 *   2. sets `courseId: "basic"` on every class that has no course yet.
 * Nothing else changes: `classes.classType`, the `classType` docs and
 * `lesson.classType` stay as they were.
 *
 * Run it AFTER the backend and website that know about courses are deployed.
 *
 * Usage (from backend/):
 *   node scripts/migrate-courses.js --db dev            # dry-run
 *   node scripts/migrate-courses.js --db dev --apply
 *   node scripts/migrate-courses.js --db prod --apply   # asks CONFIRM-PROD
 */
const readline = require("readline");

const { sortLessons } = require("../lib/courses.js");

const DB_ID = { dev: "auto-check-exer-dev", prod: "(default)" };
const BASIC_COURSE_ID = "basic";

/**
 * Pure: what to write, from plain snapshots of the collections.
 * @param {{classTypes: Array<{id, code}>, lessons: Array<{id, classType}>,
 *          classes: Array<{id, courseId}>, existingCourses: Set<string>,
 *          now: number}} input
 */
function planMigration({ classTypes, lessons, classes, existingCourses, now }) {
  const codes = new Set(classTypes.map((t) => t.code).filter(Boolean));
  const courses = [];
  if (!existingCourses.has(BASIC_COURSE_ID)) {
    const lessonIds = sortLessons(
      lessons.filter(
        (l) =>
          Array.isArray(l.classType) && l.classType.some((c) => codes.has(c)),
      ),
    ).map((l) => l.id);
    courses.push({
      id: BASIC_COURSE_ID,
      data: {
        name: "Basic",
        lessonIds,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  const classUpdates = classes
    .filter((cls) => !cls.courseId)
    .map((cls) => ({
      id: cls.id,
      data: { courseId: BASIC_COURSE_ID },
    }));
  return { courses, classUpdates };
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

  const [typeSnap, lessonSnap, classSnap, courseSnap] = await Promise.all([
    db.collection("classType").get(),
    db.collection("lesson").get(),
    db.collection("classes").get(),
    db.collection("courses").get(),
  ]);
  const plan = planMigration({
    classTypes: typeSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    lessons: lessonSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    classes: classSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    existingCourses: new Set(courseSnap.docs.map((d) => d.id)),
    now: Date.now(),
  });

  console.log(`\nMigrate to courses on ${args.db} (${DB_ID[args.db]})`);
  console.log(args.apply ? "Mode: APPLY" : "Mode: DRY-RUN (no writes)");
  for (const c of plan.courses) {
    console.log(
      `  + course ${c.id}: "${c.data.name}" (${c.data.lessonIds.length} lessons)`,
    );
  }
  console.log(`  classes to move: ${plan.classUpdates.length}`);

  if (!args.apply) {
    console.log("\n✅ Dry-run complete (re-run with --apply to write).");
    return;
  }
  if (args.db === "prod" && !args.yes) await confirmProd();

  // Courses first: a class must never point at a course that does not exist.
  const writes = [
    ...plan.courses.map((c) => ({
      ref: db.collection("courses").doc(c.id),
      op: "set",
      data: c.data,
    })),
    ...plan.classUpdates.map((u) => ({
      ref: db.collection("classes").doc(u.id),
      op: "update",
      data: u.data,
    })),
  ];
  const CHUNK = 400;
  for (let i = 0; i < writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + CHUNK)) batch[w.op](w.ref, w.data);
    await batch.commit();
  }
  console.log("\n✅ Done.");
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

module.exports = { BASIC_COURSE_ID, planMigration };
