/**
 * In-memory Firestore for tests: just the surface the backend uses, with REAL
 * transaction semantics — reads record a version, commit is atomic and fails
 * (then retries the callback) when anything read has changed since. Every read
 * yields to the event loop, so concurrent transactions genuinely interleave.
 * That is what lets the race tests (two job starts, two charges) mean anything.
 */
const SENTINEL = Symbol("fieldValue");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function timestamp(ms) {
  return { toMillis: () => ms, toDate: () => new Date(ms), seconds: ms / 1000 };
}

const FieldValue = {
  increment: (n) => ({ [SENTINEL]: "increment", n }),
  serverTimestamp: () => ({ [SENTINEL]: "serverTimestamp" }),
  arrayUnion: (...values) => ({ [SENTINEL]: "arrayUnion", values }),
};

const Timestamp = {
  now: () => timestamp(Date.now()),
  fromMillis: (ms) => timestamp(ms),
  fromDate: (date) => timestamp(date.getTime()),
};

/** Deep copy that keeps functions (Timestamp-like objects) by reference. */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object" && !value[SENTINEL]) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function resolveField(current, value) {
  if (value && value[SENTINEL] === "increment") return (current || 0) + value.n;
  if (value && value[SENTINEL] === "serverTimestamp") return Timestamp.now();
  if (value && value[SENTINEL] === "arrayUnion") {
    const base = Array.isArray(current) ? [...current] : [];
    for (const v of value.values) if (!base.includes(v)) base.push(v);
    return base;
  }
  return clone(value);
}

class NotFoundError extends Error {
  constructor(path) {
    super(`NOT_FOUND: ${path}`);
    this.code = 5;
  }
}

class FakeFirestore {
  constructor() {
    this.store = new Map(); // path -> { data, version }
    this.clock = 0;
    this.stats = { transactions: 0, retries: 0 };
  }

  collection(name) {
    return new CollectionRef(this, name);
  }

  // --- internals -----------------------------------------------------------

  _version(path) {
    return this.store.get(path)?.version ?? 0;
  }

  _snapshot(path) {
    const entry = this.store.get(path);
    const ref = new DocumentRef(this, path);
    return {
      id: ref.id,
      ref,
      exists: Boolean(entry),
      data: () => (entry ? clone(entry.data) : undefined),
    };
  }

  _apply({ type, path, data, options }) {
    const entry = this.store.get(path);
    if (type === "delete") {
      this.store.delete(path);
      return;
    }
    if (type === "update" && !entry) throw new NotFoundError(path);
    const base =
      type === "set" && !options?.merge ? {} : clone(entry?.data || {});
    for (const [k, v] of Object.entries(data))
      base[k] = resolveField(base[k], v);
    this.store.set(path, { data: base, version: ++this.clock });
  }

  async runTransaction(fn) {
    this.stats.transactions += 1;
    for (let attempt = 0; attempt < 100; attempt++) {
      const tx = new Transaction(this);
      const result = await fn(tx);
      // Commit is synchronous: nothing can interleave between check and apply.
      const clean = [...tx.reads].every(
        ([path, version]) => this._version(path) === version,
      );
      if (clean) {
        for (const w of tx.writes) {
          if (w.type === "update" && !this.store.has(w.path)) {
            throw new NotFoundError(w.path);
          }
        }
        tx.writes.forEach((w) => this._apply(w));
        return result;
      }
      this.stats.retries += 1;
      await tick();
    }
    throw new Error("transaction contention: gave up");
  }

  async getAll(...refs) {
    await tick();
    return refs.map((ref) => this._snapshot(ref.path));
  }

  batch() {
    const writes = [];
    return {
      set: (ref, data, options) =>
        writes.push({ type: "set", path: ref.path, data, options }),
      update: (ref, data) =>
        writes.push({ type: "update", path: ref.path, data }),
      delete: (ref) => writes.push({ type: "delete", path: ref.path }),
      commit: async () => {
        await tick();
        writes.forEach((w) => this._apply(w));
      },
    };
  }

  /** Test helper: every doc directly under a collection path. */
  dump(collectionPath) {
    const out = {};
    for (const [path, entry] of this.store) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent === collectionPath)
        out[path.split("/").pop()] = clone(entry.data);
    }
    return out;
  }
}

class Transaction {
  constructor(db) {
    this.db = db;
    this.reads = new Map();
    this.writes = [];
  }

  _read(path) {
    if (!this.reads.has(path)) this.reads.set(path, this.db._version(path));
    return this.db._snapshot(path);
  }

  async get(refOrQuery) {
    await tick();
    return this._read(refOrQuery.path);
  }

  async getAll(...refs) {
    await tick();
    return refs.map((ref) => this._read(ref.path));
  }

  set(ref, data, options) {
    this.writes.push({ type: "set", path: ref.path, data, options });
  }

  update(ref, data) {
    this.writes.push({ type: "update", path: ref.path, data });
  }

  delete(ref) {
    this.writes.push({ type: "delete", path: ref.path });
  }
}

class DocumentRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").pop();
  }

  collection(name) {
    return new CollectionRef(this.db, `${this.path}/${name}`);
  }

  async get() {
    await tick();
    return this.db._snapshot(this.path);
  }

  async set(data, options) {
    await tick();
    this.db._apply({ type: "set", path: this.path, data, options });
  }

  async update(data) {
    await tick();
    this.db._apply({ type: "update", path: this.path, data });
  }

  async delete() {
    await tick();
    this.db._apply({ type: "delete", path: this.path });
  }
}

let autoId = 0;

class Query {
  constructor(db, path, filters = [], max = Infinity) {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.max = max;
  }

  where(field, op, value) {
    return new Query(
      this.db,
      this.path,
      [...this.filters, { field, op, value }],
      this.max,
    );
  }

  limit(n) {
    return new Query(this.db, this.path, this.filters, n);
  }

  orderBy() {
    return this;
  }

  _matches(data) {
    return this.filters.every(({ field, op, value }) => {
      const v = data[field];
      if (op === "==") return v === value;
      if (op === "in") return value.includes(v);
      if (op === "array-contains") return Array.isArray(v) && v.includes(value);
      throw new Error(`fake firestore: unsupported op ${op}`);
    });
  }

  async get() {
    await tick();
    const docs = [];
    for (const [path, entry] of this.db.store) {
      const parent = path.slice(0, path.lastIndexOf("/"));
      if (parent !== this.path || !this._matches(entry.data)) continue;
      docs.push(this.db._snapshot(path));
      if (docs.length >= this.max) break;
    }
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach: (fn) => docs.forEach(fn),
    };
  }
}

class CollectionRef extends Query {
  constructor(db, path) {
    super(db, path);
  }

  doc(id) {
    return new DocumentRef(this.db, `${this.path}/${id ?? `auto${++autoId}`}`);
  }

  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

function createFakeAdmin() {
  return { firestore: { FieldValue, Timestamp } };
}

module.exports = { FakeFirestore, FieldValue, Timestamp, createFakeAdmin };
