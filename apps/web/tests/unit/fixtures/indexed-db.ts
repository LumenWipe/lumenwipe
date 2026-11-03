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

export function installIndexedDb(): void {
  const g = globalThis as Record<string, unknown>;
  g.indexedDB = new fakeIdb.IDBFactory();
  for (const name of GLOBALS) g[name] = fakeIdb[name];
}

export function removeIndexedDb(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.indexedDB;
  for (const name of GLOBALS) delete g[name];
}
