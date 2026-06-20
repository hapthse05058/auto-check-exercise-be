// Pure filtering/sorting for the admin teacher-management screen. No Firestore/IO
// here so it can be unit-tested directly (see backend/tests/teacherFilter.test.js).

/** True when an account counts as active (missing field => active). */
function isActive(teacher) {
  return teacher?.isAccountActive !== false;
}

/**
 * Filters + sorts teachers for the management list.
 *
 * @param teachers           array of teacher records (each with id, name, gmail, isAccountActive)
 * @param opts.q             free-text search over name/gmail (case-insensitive substring)
 * @param opts.classId       keep only teachers assigned to this class
 * @param opts.isAccountActive  "true"/"false"/true/false to filter by status (undefined = all)
 * @param classIdsByTeacher  map teacherId -> array of classIds (from class.teacherId[])
 *
 * Search ranks NAME matches above gmail-only matches, then alphabetical by name.
 */
function filterTeachers(teachers, opts = {}, classIdsByTeacher = {}) {
  const list = Array.isArray(teachers) ? teachers : [];
  const q = String(opts.q ?? "").trim().toLowerCase();

  // Normalize the status filter: accept boolean or "true"/"false" string; anything
  // else (undefined / "all" / "") means no status filtering.
  let statusFilter = null;
  if (opts.isAccountActive === true || opts.isAccountActive === "true") statusFilter = true;
  else if (opts.isAccountActive === false || opts.isAccountActive === "false") statusFilter = false;

  const filtered = list.filter((tch) => {
    if (statusFilter !== null && isActive(tch) !== statusFilter) return false;
    if (opts.classId) {
      const ids = classIdsByTeacher[tch.id] || [];
      if (!ids.includes(opts.classId)) return false;
    }
    if (q) {
      const name = String(tch.name ?? "").toLowerCase();
      const gmail = String(tch.gmail ?? "").toLowerCase();
      if (!name.includes(q) && !gmail.includes(q)) return false;
    }
    return true;
  });

  if (!q) {
    return filtered.sort((a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? "")),
    );
  }

  // Name matches first, then gmail-only matches; alphabetical within each group.
  const nameMatch = (t) => String(t.name ?? "").toLowerCase().includes(q);
  return filtered.sort((a, b) => {
    const an = nameMatch(a);
    const bn = nameMatch(b);
    if (an !== bn) return an ? -1 : 1;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
}

/** Diff two classId lists into { added, removed } (for syncing class.teacherId). */
function diffClassIds(oldIds, newIds) {
  const before = new Set(Array.isArray(oldIds) ? oldIds : []);
  const after = new Set(Array.isArray(newIds) ? newIds : []);
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  return { added, removed };
}

module.exports = { isActive, filterTeachers, diffClassIds };
