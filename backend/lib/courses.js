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
 * `gradingProfile` picks HOW a course's classes are graded: "basic" (the
 * sentence/paragraph prompts, lib/doc tables), "ielts" (lib/ieltsWriting.js,
 * its own prompt and its own doc template) or "hs" (the HS course for primary
 * and lower-secondary pupils: lib/hsGrading.js, prompt_hs.txt, lib/doc/hsDoc.js).
 * A course stored before the field existed — and every class without a
 * course — grades as "basic", unchanged. Any OTHER stored value is unknown and
 * refused (null), never graded as Basic: a course made for a profile this
 * build does not know must not get another profile's prompt and doc writer.
 *
 * A class on a course still records its template in `classes.classType`: the
 * teacher picks one of the course's templates (`classType/{id}`: {code, name,
 * gradingProfile?}) when creating the class. A template belongs to the
 * profile in its `gradingProfile` field, or by its code: "ielts…" is IELTS,
 * anything else (the three `basic_…` templates) Basic.
 */

const NAME_MAX = 120;

const GRADING_PROFILE_BASIC = "basic";
const GRADING_PROFILE_IELTS = "ielts";
const GRADING_PROFILE_HS = "hs";
const GRADING_PROFILES = [
  GRADING_PROFILE_BASIC,
  GRADING_PROFILE_IELTS,
  GRADING_PROFILE_HS,
];

/**
 * The stored profile; "basic" for a course from before profiles existed (no
 * field, or ""); null for a value this build does not know — the caller
 * refuses it (fail closed) rather than grading it as Basic.
 */
function gradingProfileOf(course) {
  const value = course?.gradingProfile;
  if (value === undefined || value === "") return GRADING_PROFILE_BASIC;
  return GRADING_PROFILES.includes(value) ? value : null;
}

/** The grading profile a doc template (a `classType` doc) belongs to. */
function templateProfileOf(template) {
  if (GRADING_PROFILES.includes(template?.gradingProfile)) {
    return template.gradingProfile;
  }
  return /^ielts/i.test(String(template?.code || ""))
    ? GRADING_PROFILE_IELTS
    : GRADING_PROFILE_BASIC;
}
const LESSONS_MAX = 200;

/**
 * A template's code is what `classes.classType` stores and what the doc-table
 * detection keys its overrides on (lib/doc/docTables.js), so it is fixed once
 * created: lowercase letters, digits, "_" and "-".
 */
const TEMPLATE_CODE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

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

  if (input.gradingProfile !== undefined) {
    if (!GRADING_PROFILES.includes(input.gradingProfile)) {
      throw new CourseError(400, "invalid_grading_profile");
    }
    out.gradingProfile = input.gradingProfile;
  }

  return out;
}

/**
 * Validates a template create (`partial: false`: code, name, gradingProfile)
 * or edit (`partial: true`: name and/or gradingProfile — never the code).
 * Returns only the fields that were given, normalized. Throws CourseError(400).
 */
function validateTemplateInput(body, { partial = false } = {}) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};

  if (!partial) {
    const code = String(input.code ?? "")
      .trim()
      .toLowerCase();
    if (!code) throw new CourseError(400, "code_required");
    if (!TEMPLATE_CODE_RE.test(code)) {
      throw new CourseError(400, "invalid_code");
    }
    out.code = code;
  } else if (input.code !== undefined) {
    throw new CourseError(400, "code_immutable");
  }

  if (input.name !== undefined || !partial) {
    const name = String(input.name ?? "").trim();
    if (!name) throw new CourseError(400, "name_required");
    if (name.length > NAME_MAX) throw new CourseError(400, "name_too_long");
    out.name = name;
  }

  if (input.gradingProfile !== undefined || !partial) {
    if (!GRADING_PROFILES.includes(input.gradingProfile)) {
      throw new CourseError(400, "invalid_grading_profile");
    }
    out.gradingProfile = input.gradingProfile;
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
    gradingProfile: gradingProfileOf(d),
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
    await ref.set({
      gradingProfile: GRADING_PROFILE_BASIC,
      ...input,
      isActive: true,
      createdAt: at,
      updatedAt: at,
    });
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

  const templateCol = () => db.collection("classType");

  function describeTemplate(snap) {
    const data = snap.data() || {};
    return {
      id: snap.id,
      code: data.code || snap.id,
      name: data.name || data.code || snap.id,
      gradingProfile: templateProfileOf(data),
      createdAt: data.createdAt ?? null,
      updatedAt: data.updatedAt ?? null,
    };
  }

  /** Every doc template, each with the profile it belongs to, by name. */
  async function templates() {
    const snap = await templateCol().get();
    return snap.docs
      .map(describeTemplate)
      .sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }

  async function getTemplate(templateId) {
    if (!templateId || String(templateId).includes("/")) return null;
    const snap = await templateCol().doc(String(templateId)).get();
    return snap.exists ? describeTemplate(snap) : null;
  }

  /**
   * Who uses a template: the classes whose `classType` is its code (active
   * ones by name — they block a delete or a profile change) and the lessons
   * that list it in `lesson.classType`.
   */
  async function templateUsage(code) {
    const [classSnap, lessonSnap] = await Promise.all([
      db.collection("classes").where("classType", "==", code).get(),
      lessonCol().where("classType", "array-contains", code).get(),
    ]);
    const active = classSnap.docs
      .filter((d) => d.data().isActive !== false)
      .map((d) => d.data().name || d.id);
    return {
      classCount: classSnap.size,
      activeClasses: active,
      lessonCount: lessonSnap.size,
    };
  }

  /** The templates with their usage — the admin's template screen. */
  async function templatesWithUsage() {
    const list = await templates();
    return Promise.all(
      list.map(async (template) => {
        const usage = await templateUsage(template.code);
        return {
          ...template,
          classCount: usage.classCount,
          activeClassCount: usage.activeClasses.length,
          lessonCount: usage.lessonCount,
        };
      }),
    );
  }

  async function assertUniqueTemplate({ code, name }, exceptId) {
    const snap = await templateCol().get();
    for (const d of snap.docs) {
      if (d.id === exceptId) continue;
      const other = describeTemplate(d);
      if (code && (d.id === code || other.code === code)) {
        throw new CourseError(409, "duplicate_code");
      }
      if (name && other.name.trim().toLowerCase() === name.toLowerCase()) {
        throw new CourseError(409, "duplicate_template_name");
      }
    }
  }

  /** A new template; its doc id is its code. */
  async function createTemplate(body) {
    const input = validateTemplateInput(body);
    await assertUniqueTemplate(input);
    const at = now();
    await templateCol()
      .doc(input.code)
      .set({ ...input, createdAt: at, updatedAt: at });
    return getTemplate(input.code);
  }

  /**
   * Renames a template or moves it to another grading profile. The move is
   * refused while an active class uses it: that class's course is of the old
   * profile, and a template must belong to its class's course.
   */
  async function updateTemplate(templateId, body) {
    const current = await getTemplate(templateId);
    if (!current) throw new CourseError(404, "template_not_found");
    const input = validateTemplateInput(body, { partial: true });
    if (input.name === current.name) delete input.name;
    if (input.gradingProfile === current.gradingProfile) {
      delete input.gradingProfile;
    }
    if (Object.keys(input).length === 0) {
      throw new CourseError(400, "nothing_to_update");
    }
    if (input.name)
      await assertUniqueTemplate({ name: input.name }, current.id);
    if (input.gradingProfile) {
      const { activeClasses } = await templateUsage(current.code);
      if (activeClasses.length) {
        throw new CourseError(409, "template_in_use", {
          classes: activeClasses,
        });
      }
    }
    await templateCol()
      .doc(current.id)
      .update({ ...input, updatedAt: now() });
    return getTemplate(current.id);
  }

  /**
   * Deletes a template no active class uses. Closed classes keep the code
   * (shown as is); lessons keep listing it, which nothing reads any more.
   */
  async function deleteTemplate(templateId) {
    const current = await getTemplate(templateId);
    if (!current) throw new CourseError(404, "template_not_found");
    const { activeClasses } = await templateUsage(current.code);
    if (activeClasses.length) {
      throw new CourseError(409, "template_in_use", { classes: activeClasses });
    }
    await templateCol().doc(current.id).delete();
    return current;
  }

  /**
   * Checks the template picked for a class on `course`: a known code of the
   * course's grading profile. Returns the template.
   */
  async function resolveTemplate(code, course) {
    const template = (await templates()).find(
      (item) => item.code === String(code ?? "").trim(),
    );
    if (!template) throw new CourseError(400, "template_not_found");
    if (template.gradingProfile !== course.gradingProfile) {
      throw new CourseError(400, "template_not_in_course");
    }
    return template;
  }

  return {
    allLessons,
    create,
    createTemplate,
    deleteTemplate,
    get,
    getTemplate,
    lessonsForClass,
    lessonsForCourse,
    list,
    resolveForClass,
    resolveTemplate,
    templates,
    templatesWithUsage,
    update,
    updateTemplate,
  };
}

module.exports = {
  CourseError,
  GRADING_PROFILE_BASIC,
  GRADING_PROFILE_IELTS,
  GRADING_PROFILE_HS,
  GRADING_PROFILES,
  gradingProfileOf,
  createCourses,
  lessonNumber,
  sortLessons,
  templateProfileOf,
  validateCourseInput,
  validateTemplateInput,
};
