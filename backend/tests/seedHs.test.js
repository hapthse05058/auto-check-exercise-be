/** scripts/seed-hs.js — the HS course's lessons, template and course. */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { templateProfileOf } = require("../lib/courses.js");
const {
  HS_COURSE_ID,
  HS_TEMPLATE_CODE,
  hsLessons,
  planSeed,
} = require("../scripts/seed-hs.js");

const none = () => ({
  lessons: new Set(),
  templates: new Set(),
  courses: new Set(),
});

describe("seed-hs", () => {
  it("creates 26 lessons, the HS template and the course, in lesson order", async () => {
    const lessons = await hsLessons();
    const writes = planSeed({ lessons, existing: none(), now: 1 });
    const lessonWrites = writes.filter((w) => w.collection === "lesson");
    assert.equal(lessonWrites.length, 26);
    assert.deepEqual(lessonWrites[8], {
      collection: "lesson",
      id: "hsLesson09",
      data: { name: "Buổi 09", classType: [HS_TEMPLATE_CODE] },
    });
    const template = writes.find((w) => w.collection === "classType");
    assert.equal(templateProfileOf(template.data), "hs");
    const course = writes.find((w) => w.collection === "courses");
    assert.equal(course.id, HS_COURSE_ID);
    assert.equal(course.data.gradingProfile, "hs");
    assert.deepEqual(course.data.lessonIds, [
      ...Array.from(
        { length: 24 },
        (_, i) => `hsLesson${String(i + 1).padStart(2, "0")}`,
      ),
      "hsReview1",
      "hsReview2",
    ]);
  });

  it("touches nothing that exists: a second run writes nothing", async () => {
    const lessons = await hsLessons();
    const writes = planSeed({
      lessons,
      existing: {
        lessons: new Set(lessons.map((l) => l.id)),
        templates: new Set([HS_TEMPLATE_CODE]),
        courses: new Set([HS_COURSE_ID]),
      },
      now: 1,
    });
    assert.deepEqual(writes, []);
  });
});
