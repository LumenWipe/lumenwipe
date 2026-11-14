import { expect, test } from "bun:test";
import { installIndexedDb, removeIndexedDb, takeIndexedDbReach } from "./fixtures/indexed-db";

function reach(): unknown {
  return (globalThis as { indexedDB?: unknown }).indexedDB;
}

test("a test that reaches IndexedDB without installing it is caught", () => {
  expect(reach).toThrow(/indexedDB is not installed/);
  expect(takeIndexedDbReach()).toBe(true);
  expect(takeIndexedDbReach()).toBe(false);
});

test("an installed IndexedDB is used freely, and removing it guards it again", () => {
  installIndexedDb();
  expect(reach()).toBeDefined();
  expect(takeIndexedDbReach()).toBe(false);

  removeIndexedDb();
  expect(reach).toThrow(/indexedDB is not installed/);
  expect(takeIndexedDbReach()).toBe(true);
});
