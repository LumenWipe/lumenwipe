import { test, expect } from "bun:test";
import {
  createFirestore,
  DEFAULT_FIRESTORE_DATABASE,
  firestoreDatabaseId,
  firestoreDatabaseLine,
  isFirestoreDatabaseId,
} from "@/config/firestore";

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => vars as NodeJS.ProcessEnv;

test("an unset or blank FIRESTORE_DATABASE_ID means (default)", () => {
  expect(firestoreDatabaseId(env({}))).toBe(DEFAULT_FIRESTORE_DATABASE);
  expect(firestoreDatabaseId(env({ FIRESTORE_DATABASE_ID: "   " }))).toBe("(default)");
});

test("a set FIRESTORE_DATABASE_ID is used trimmed", () => {
  expect(firestoreDatabaseId(env({ FIRESTORE_DATABASE_ID: " restore-drill " }))).toBe(
    "restore-drill"
  );
});

test.each(["(default)", "abcd", "restore-2026-11-09", "a".repeat(63), "k9s0"])(
  "%p is a valid database id",
  (id) => {
    expect(isFirestoreDatabaseId(id)).toBe(true);
  }
);

test.each([
  "",
  "abc",
  "Restore",
  "restore-",
  "1restore",
  "-restore",
  "re_store",
  "a".repeat(64),
  "(DEFAULT)",
])("%p is not a valid database id", (id) => {
  expect(isFirestoreDatabaseId(id)).toBe(false);
});

test("the boot line names the database only when Firestore is in use", () => {
  expect(firestoreDatabaseLine(env({}))).toBeNull();
  expect(firestoreDatabaseLine(env({ FIRESTORE_PROJECT_ID: "test-project" }))).toBe(
    "Firestore database: (default)"
  );
  expect(
    firestoreDatabaseLine(
      env({ FIRESTORE_PROJECT_ID: "test-project", FIRESTORE_DATABASE_ID: "restore-drill" })
    )
  ).toBe("Firestore database: restore-drill");
});

test("the client targets the configured database", () => {
  expect(createFirestore("test-project", env({})).databaseId).toBe("(default)");
  expect(
    createFirestore("test-project", env({ FIRESTORE_DATABASE_ID: "restore-drill" })).databaseId
  ).toBe("restore-drill");
});
