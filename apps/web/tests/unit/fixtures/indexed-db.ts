import * as fakeIdb from "fake-indexeddb";

// A real IndexedDB, in memory, so transactions serialize the way a browser's do. Installed per
// test and removed after, so no other test file sees a database.
const GLOBALS = [
  "IDBCursor",
  "IDBCursorWithValue",
  "IDBDatabase",
  "IDBIndex",
  "IDBKeyRange",
  "IDBObjectStore",
  "IDBOpenDBRequest",
  "IDBRequest",
  "IDBTransaction",
  "IDBVersionChangeEvent",
] as const;

let reached = false;

/** Stands in for IndexedDB while no test has installed it: a reach throws as a missing global
 *  would, and is recorded so the test it happened in fails instead of passing by file order. */
export function guardIndexedDb(): void {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    get() {
      reached = true;
      throw new ReferenceError(
        "indexedDB is not installed: call installIndexedDb from tests/unit/fixtures/indexed-db.ts"
      );
    },
  });
}

/** Whether the guard was reached since the last call, which clears it. */
export function takeIndexedDbReach(): boolean {
  const was = reached;
  reached = false;
  return was;
}

export function installIndexedDb(): void {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    writable: true,
    value: new fakeIdb.IDBFactory(),
  });
  const g = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) g[name] = fakeIdb[name];
}

export function removeIndexedDb(): void {
  const g = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) delete g[name];
  guardIndexedDb();
}
