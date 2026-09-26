/**
 * Courses (khóa): Basic, IELTS, … A class follows one course, and the course
 * lists the lessons its classes go through. Courses live in
 * `courses/{courseId}` and are managed by admins:
 *
 *   { name, lessonIds: ["lesson01", ...], isActive, createdAt, updatedAt }
 *
 * A hidden course (`isActive: false`) cannot be picked for a new class but
 * keeps serving the classes already on it.
 *
 * BEFORE COURSES a class carried the student-doc template it used
 * (`basic_since_01042026`, …) in `classes.classType`, and each lesson listed
 * the templates it belonged to in `lesson.classType`. That field is left as it
 * is; a class that has no `courseId` yet still gets its lessons through it —
 * `lessonsForClass` — so the backend can ship before
 * scripts/migrate-courses.js puts every existing class on the Basic course.
 *
 * Later each course will carry its own grading system prompt; the class's
 * `courseId` is what grading will look it up by.
 */

const NAME_MAX = 120;
const LESSONS_MAX = 200;

class CourseError extends Error {
  constructor(status, code, params) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params || null;
  }
}

/** "lesson05" → 5; null for an id that is not numbered. */
function lessonNumber(id) {
  const match = /^lesson(\d+)$/.exec(String(id || ""));
  return match ? Number(match[1]) : null;
}

/** Lessons in course order: by the `lessonNN` number, then by id. */
function sortLessons(lessons) {
  return [...lessons].sort((a, b) => {
    const na = lessonNumber(a.id);
    const nb = lessonNumber(b.id);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    if (na === null && nb !== null) return 1;
    if (na !== null && nb === null) return -1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function sortLessonIds(ids) {
  return sortLessons(ids.map((id) => ({ id }))).map((l) => l.id);
}

/**
 * Validates a create (`partial: false`) or edit (`partial: true`) body and
 * returns only the fields that were given, normalized. Throws CourseError(400).
 */
function validateCourseInput(body, { partial = false } = {}) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};

  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new CourseError(400, "name_required");
    if (name.length > NAME_MAX) throw new CourseError(400, "name_too_long");
    out.name = name;
  }

  if (input.lessonIds !== undefined || !partial) {
    if (!Array.isArray(input.lessonIds)) {
      throw new CourseError(400, "lessons_required");
    }
    const ids = [
      ...new Set(input.lessonIds.map((id) => String(id ?? "").trim())),
    ].filter(Boolean);
    if (ids.length === 0) throw new CourseError(400, "lessons_required");
    if (ids.length > LESSONS_MAX)
      throw new CourseError(400, "too_many_lessons");
    if (ids.some((id) => id.includes("/"))) {
      throw new CourseError(400, "unknown_lessons");
    }
    out.lessonIds = sortLessonIds(ids);
  }

  if (input.isActive !== undefined) {
    if (typeof input.isActive !== "boolean") {
      throw new CourseError(400, "invalid_is_active");
    }
    out.isActive = input.isActive;
  }

  return out;
}

function describeCourse(snap) {
  const d = snap.data() || {};
  return {
    id: snap.id,
    name: d.name || snap.id,
    lessonIds: Array.isArray(d.lessonIds) ? d.lessonIds : [],
    isActive: d.isActive !== false,
    createdAt: d.createdAt ?? null,
    updatedAt: d.updatedAt ?? null,
  };
}

function createCourses({ db, now = () => Date.now() }) {
  const courses = () => db.collection("courses");
  const lessonCol = () => db.collection("lesson");

  async function readLessons(ids) {
    if (ids.length === 0) return [];
    const snaps = await db.getAll(...ids.map((id) => lessonCol().doc(id)));
    return snaps
      .filter((s) => s.exists)
      .map((s) => ({ id: s.id, ...s.data() }));
  }

  async function requireLessons(ids) {
    const found = new Set((await readLessons(ids)).map((l) => l.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new CourseError(400, "unknown_lessons", { lessons: missing });
    }
  }

  async function assertUniqueName(name, exceptId) {
    const snap = await courses().get();
    const taken = snap.docs.some(
      (d) =>
        d.id !== exceptId &&
        String(d.data().name || "")
          .trim()
          .toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new CourseError(409, "duplicate_name");
  }

  async function list({ includeInactive = false } = {}) {
    const snap = await courses().get();
    return snap.docs
      .map(describeCourse)
      .filter((c) => includeInactive || c.isActive)
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }

  async function get(courseId) {
    if (!courseId || String(courseId).includes("/")) return null;
    const snap = await courses().doc(String(courseId)).get();
    return snap.exists ? describeCourse(snap) : null;
  }

  async function create(body) {
    const input = validateCourseInput(body);
    await requireLessons(input.lessonIds);
    await assertUniqueName(input.name);
    const at = now();
    const ref = courses().doc();
    await ref.set({ ...input, isActive: true, createdAt: at, updatedAt: at });
    return get(ref.id);
  }

  /**
   * Edits a course. Dropping a lesson that is some active class's current
   * lesson is refused: that class would be left on a lesson its course lacks.
   */
  async function update(courseId, body) {
    const current = await get(courseId);
    if (!current) throw new CourseError(404, "course_not_found");
    const input = validateCourseInput(body, { partial: true });
    if (Object.keys(input).length === 0) {
      throw new CourseError(400, "nothing_to_update");
    }

    if (input.lessonIds) {
      await requireLessons(input.lessonIds);
      const classes = await db
        .collection("classes")
        .where("courseId", "==", courseId)
        .get();
      const keep = new Set(input.lessonIds);
      const stranded = classes.docs.filter((d) => {
        const lesson = d.data().currentLesson;
        return lesson && !keep.has(lesson) && d.data().isActive !== false;
      });
      if (stranded.length) {
        throw new CourseError(409, "lesson_in_use", {
          classes: stranded.map((d) => d.data().name || d.id),
        });
      }
    }
    if (input.name) await assertUniqueName(input.name, courseId);

    await courses()
      .doc(courseId)
      .update({ ...input, updatedAt: now() });
    return get(courseId);
  }

  /** Every lesson, in course order — the admin's lesson picker. */
  async function allLessons() {
    const snap = await lessonCol().get();
    return sortLessons(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  async function lessonsForCourse(courseId) {
    const course = await get(courseId);
    if (!course) return [];
    return sortLessons(await readLessons(course.lessonIds));
  }

  /** The lessons a class goes through: its course's, or the legacy lookup. */
  async function lessonsForClass(classData) {
    if (classData?.courseId) return lessonsForCourse(classData.courseId);
    const legacy = classData?.classType;
    if (!legacy) return [];
    const snap = await lessonCol()
      .where("classType", "array-contains", legacy)
      .get();
    return sortLessons(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }

  /**
   * Checks the course picked for a new class, or a class moving to another
   * course (`keepCourseId`: the class's own course, usable even when hidden).
   */
  async function resolveForClass({
    courseId,
    currentLesson,
    keepCourseId = null,
  }) {
    const course = await get(courseId);
    if (!course) throw new CourseError(400, "course_not_found");
    if (!course.isActive && course.id !== keepCourseId) {
      throw new CourseError(400, "course_inactive");
    }
    if (currentLesson && !course.lessonIds.includes(currentLesson)) {
      throw new CourseError(400, "lesson_not_in_course");
    }
    return course;
  }

  return {
    allLessons,
    create,
    get,
    lessonsForClass,
    lessonsForCourse,
    list,
    resolveForClass,
    update,
  };
}

module.exports = {
  CourseError,
  createCourses,
  lessonNumber,
  sortLessons,
  validateCourseInput,
};
