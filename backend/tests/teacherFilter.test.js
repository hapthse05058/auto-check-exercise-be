const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isActive,
  filterTeachers,
  diffClassIds,
} = require("../lib/teacherFilter.js");

const TEACHERS = [
  { id: "t1", name: "An Nguyen", gmail: "an@x.com", isAccountActive: true },
  { id: "t2", name: "Binh Pham", gmail: "binh@x.com", isAccountActive: false },
  { id: "t3", name: "Chau Le", gmail: "nguyenle@x.com" }, // missing field => active
];
const CLASS_MAP = { t1: ["class01"], t3: ["class01", "class02"] };

test("isActive: missing field counts as active", () => {
  assert.equal(isActive({ id: "x" }), true);
  assert.equal(isActive({ isAccountActive: false }), false);
});

test("status filter: true hides closed accounts", () => {
  const r = filterTeachers(TEACHERS, { isAccountActive: "true" }, CLASS_MAP);
  assert.deepEqual(
    r.map((t) => t.id),
    ["t1", "t3"],
  );
});

test("status filter: false keeps only closed accounts", () => {
  const r = filterTeachers(TEACHERS, { isAccountActive: false }, CLASS_MAP);
  assert.deepEqual(
    r.map((t) => t.id),
    ["t2"],
  );
});

test("no status filter: returns all, sorted by name", () => {
  const r = filterTeachers(TEACHERS, {}, CLASS_MAP);
  assert.deepEqual(
    r.map((t) => t.id),
    ["t1", "t2", "t3"],
  ); // An, Binh, Chau
});

test("class filter: only teachers assigned to that class", () => {
  const r = filterTeachers(TEACHERS, { classId: "class02" }, CLASS_MAP);
  assert.deepEqual(
    r.map((t) => t.id),
    ["t3"],
  );
});

test("search: name match ranks above gmail-only match", () => {
  // q="nguyen": t1 matches by name ("An Nguyen"); t3 matches by gmail ("nguyenle@x.com").
  const r = filterTeachers(TEACHERS, { q: "nguyen" }, CLASS_MAP);
  assert.deepEqual(
    r.map((t) => t.id),
    ["t1", "t3"],
  );
});

test("search: no match → empty", () => {
  assert.deepEqual(filterTeachers(TEACHERS, { q: "zzz" }, CLASS_MAP), []);
});

test("search combines with status filter", () => {
  // q="pham" matches "Binh Pham" (name) but t2 is closed → excluded when active-only.
  const r = filterTeachers(
    TEACHERS,
    { q: "pham", isAccountActive: "true" },
    CLASS_MAP,
  );
  assert.deepEqual(
    r.map((t) => t.id),
    [],
  );
});

test("diffClassIds: computes added and removed", () => {
  assert.deepEqual(diffClassIds(["a", "b"], ["b", "c"]), {
    added: ["c"],
    removed: ["a"],
  });
});

test("diffClassIds: handles empty / undefined", () => {
  assert.deepEqual(diffClassIds(undefined, ["a"]), {
    added: ["a"],
    removed: [],
  });
  assert.deepEqual(diffClassIds(["a"], undefined), {
    added: [],
    removed: ["a"],
  });
  assert.deepEqual(diffClassIds([], []), { added: [], removed: [] });
});
