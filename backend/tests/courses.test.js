const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  CourseError,
  createCourses,
  sortLessons,
  validateCourseInput,
} = require("../lib/courses.js");
const { planMigration } = require("../scripts/migrate-courses.js");
const { FakeFirestore } = require("./helpers/fakeFirestore.js");

function setup() {
  const db = new FakeFirestore();
  const seed = (path, data) => db._apply({ type: "set", path, data });
  for (const n of ["01", "02", "03", "10"]) {
    seed(`lesson/lesson${n}`, {
      name: `BUỔI ${n}`,
      classType: ["basic_since_01042026"],
    });
  }
  let clock = 1000;
  const courses = createCourses({ db, now: () => ++clock });
  return { db, seed, courses };
}

async function rejects(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CourseError, String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

describe("course input", () => {
  it("normalizes a new course", () => {
    assert.deepEqual(
      validateCourseInput({
        name: "  IELTS ",
        lessonIds: ["lesson10", "lesson02", "lesson02", " "],
      }),
      { name: "IELTS", lessonIds: ["lesson02", "lesson10"] },
    );
  });

  it("rejects what a course cannot be", () => {
    const base = { name: "A", lessonIds: ["lesson01"] };
    const code = (body, opts) => {
      try {
        validateCourseInput(body, opts);
        return null;
      } catch (error) {
        return error.code;
      }
    };
    assert.equal(code({ ...base, name: " " }), "name_required");
    assert.equal(code({ ...base, name: "x".repeat(121) }), "name_too_long");
    assert.equal(code({ ...base, lessonIds: [] }), "lessons_required");
    assert.equal(code({ ...base, lessonIds: "lesson01" }), "lessons_required");
    assert.equal(code({ ...base, isActive: "no" }), "invalid_is_active");
    assert.equal(
      code({}, { partial: true }),
      null,
      "an empty edit is caught later",
    );
  });

  it("orders lessons by their number, unnumbered last", () => {
    const ids = sortLessons(
      ["lesson10", "x", "lesson02", "lesson1"].map((id) => ({ id })),
    ).map((l) => l.id);
    assert.deepEqual(ids, ["lesson1", "lesson02", "lesson10", "x"]);
  });
});

describe("courses", () => {
  it("creates, lists and hides a course", async () => {
    const { courses } = setup();
    const created = await courses.create({
      name: "Basic",
      lessonIds: ["lesson02", "lesson01"],
    });
    assert.equal(created.isActive, true);
    assert.deepEqual(created.lessonIds, ["lesson01", "lesson02"]);
    await courses.create({ name: "IELTS", lessonIds: ["lesson01"] });

    assert.deepEqual(
      (await courses.list()).map((c) => c.name),
      ["Basic", "IELTS"],
    );
    await courses.update(created.id, { isActive: false });
    assert.deepEqual(
      (await courses.list()).map((c) => c.name),
      ["IELTS"],
    );
    assert.equal((await courses.list({ includeInactive: true })).length, 2);
  });

  it("grades as basic unless the course says ielts", async () => {
    const { courses, seed } = setup();
    const basic = await courses.create({ name: "B", lessonIds: ["lesson01"] });
    assert.equal(basic.gradingProfile, "basic");

    const ielts = await courses.create({
      name: "I",
      lessonIds: ["lesson01"],
      gradingProfile: "ielts",
    });
    assert.equal(ielts.gradingProfile, "ielts");

    // A course stored before the field existed.
    seed("courses/old", { name: "Old", lessonIds: ["lesson01"] });
    assert.equal((await courses.get("old")).gradingProfile, "basic");

    const moved = await courses.update(basic.id, { gradingProfile: "ielts" });
    assert.equal(moved.gradingProfile, "ielts");
    await rejects(
      courses.update(basic.id, { gradingProfile: "toeic" }),
      400,
      "invalid_grading_profile",
    );
  });

  it("refuses unknown lessons and a duplicate name", async () => {
    const { courses } = setup();
    await rejects(
      courses.create({ name: "A", lessonIds: ["lesson99"] }),
      400,
      "unknown_lessons",
    );
    const a = await courses.create({ name: "A", lessonIds: ["lesson01"] });
    await rejects(
      courses.create({ name: " a ", lessonIds: ["lesson01"] }),
      409,
      "duplicate_name",
    );
    const b = await courses.create({ name: "B", lessonIds: ["lesson01"] });
    await rejects(courses.update(b.id, { name: "A" }), 409, "duplicate_name");
    // Keeping its own name is not a clash.
    await courses.update(a.id, { name: "A", lessonIds: ["lesson02"] });
  });

  it("will not drop the lesson an active class is on", async () => {
    const { courses, seed } = setup();
    const c = await courses.create({
      name: "A",
      lessonIds: ["lesson01", "lesson02", "lesson03"],
    });
    seed("classes/k1", {
      name: "Lớp 1",
      courseId: c.id,
      currentLesson: "lesson02",
      isActive: true,
    });
    seed("classes/k2", {
      name: "Lớp 2",
      courseId: c.id,
      currentLesson: "lesson03",
      isActive: false,
    });

    await rejects(
      courses.update(c.id, { lessonIds: ["lesson01", "lesson03"] }),
      409,
      "lesson_in_use",
    );
    // Dropping the lesson only an inactive class sits on is fine.
    const edited = await courses.update(c.id, {
      lessonIds: ["lesson01", "lesson02"],
    });
    assert.deepEqual(edited.lessonIds, ["lesson01", "lesson02"]);
    await rejects(courses.update(c.id, {}), 400, "nothing_to_update");
    await rejects(
      courses.update("nope", { name: "B" }),
      404,
      "course_not_found",
    );
  });

  it("resolves the course of a class", async () => {
    const { courses } = setup();
    const c = await courses.create({ name: "A", lessonIds: ["lesson01"] });
    assert.equal(
      (
        await courses.resolveForClass({
          courseId: c.id,
          currentLesson: "lesson01",
        })
      ).id,
      c.id,
    );
    await rejects(
      courses.resolveForClass({ courseId: c.id, currentLesson: "lesson02" }),
      400,
      "lesson_not_in_course",
    );
    await courses.update(c.id, { isActive: false });
    await rejects(
      courses.resolveForClass({ courseId: c.id }),
      400,
      "course_inactive",
    );
    // ...unless the class is already on it.
    await courses.resolveForClass({ courseId: c.id, keepCourseId: c.id });
    await rejects(
      courses.resolveForClass({ courseId: "nope" }),
      400,
      "course_not_found",
    );
  });

  it("offers each course only its own doc templates", async () => {
    const { courses, seed } = setup();
    seed("classType/classType02", {
      code: "basic_since_01042026",
      name: "Mẫu tháng 4",
    });
    seed("classType/classType03", {
      code: "basic_since_20072026",
      name: "Mẫu 20/07",
    });
    seed("classType/ielts01", { code: "ielts_writing", name: "IELTS" });
    seed("classType/odd", {
      code: "custom",
      name: "Custom",
      gradingProfile: "ielts",
    });
    const profiles = Object.fromEntries(
      (await courses.templates()).map((t) => [t.code, t.gradingProfile]),
    );
    assert.deepEqual(profiles, {
      basic_since_01042026: "basic",
      basic_since_20072026: "basic",
      ielts_writing: "ielts",
      custom: "ielts",
    });

    const basic = await courses.create({ name: "B", lessonIds: ["lesson01"] });
    const ielts = await courses.create({
      name: "I",
      lessonIds: ["lesson01"],
      gradingProfile: "ielts",
    });
    assert.equal(
      (await courses.resolveTemplate("basic_since_20072026", basic)).code,
      "basic_since_20072026",
    );
    assert.equal(
      (await courses.resolveTemplate("ielts_writing", ielts)).code,
      "ielts_writing",
    );
    await rejects(
      courses.resolveTemplate("ielts_writing", basic),
      400,
      "template_not_in_course",
    );
    await rejects(
      courses.resolveTemplate("basic_since_01042026", ielts),
      400,
      "template_not_in_course",
    );
    await rejects(
      courses.resolveTemplate("nope", basic),
      400,
      "template_not_found",
    );
  });

  it("lists a class's lessons: by course, else by the old template", async () => {
    const { courses } = setup();
    const c = await courses.create({
      name: "A",
      lessonIds: ["lesson10", "lesson02"],
    });
    const ids = (list) => list.map((l) => l.id);
    // The course wins over the old template code the class still carries.
    assert.deepEqual(
      ids(
        await courses.lessonsForClass({
          courseId: c.id,
          classType: "basic_since_01042026",
        }),
      ),
      ["lesson02", "lesson10"],
    );
    assert.deepEqual(
      ids(await courses.lessonsForClass({ classType: "basic_since_01042026" })),
      ["lesson01", "lesson02", "lesson03", "lesson10"],
    );
    assert.deepEqual(await courses.lessonsForClass({}), []);
    assert.equal((await courses.allLessons()).length, 4);
  });
});

describe("migration to courses", () => {
  const input = {
    classTypes: [
      { id: "classType01", code: "basic_before_31032026" },
      { id: "classType02", code: "basic_since_01042026" },
    ],
    lessons: [
      { id: "lesson10", classType: ["basic_since_01042026"] },
      {
        id: "lesson02",
        classType: ["basic_before_31032026", "basic_since_01042026"],
      },
      { id: "lessonX", classType: ["something_else"] },
    ],
    classes: [
      { id: "a", classType: "basic_since_01042026" },
      { id: "b", classType: "basic_before_31032026" },
      { id: "c", classType: "basic_since_01042026", courseId: "other" },
    ],
    existingCourses: new Set(),
    now: 5,
  };

  it("puts every class without a course on one Basic course", () => {
    const plan = planMigration(input);
    assert.deepEqual(plan.courses, [
      {
        id: "basic",
        data: {
          name: "Basic",
          lessonIds: ["lesson02", "lesson10"],
          isActive: true,
          createdAt: 5,
          updatedAt: 5,
        },
      },
    ]);
    assert.deepEqual(plan.classUpdates, [
      { id: "a", data: { courseId: "basic" } },
      { id: "b", data: { courseId: "basic" } },
    ]);
  });

  it("is a no-op the second time", () => {
    const plan = planMigration({
      ...input,
      classes: input.classes.map((c) => ({ ...c, courseId: "basic" })),
      existingCourses: new Set(["basic"]),
    });
    assert.deepEqual(plan, { courses: [], classUpdates: [] });
  });
});
