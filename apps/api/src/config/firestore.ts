import { Firestore } from "@google-cloud/firestore";

export const DEFAULT_FIRESTORE_DATABASE = "(default)";

// Firestore's own rule for a named database id.
const DATABASE_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;

export function isFirestoreDatabaseId(id: string): boolean {
  return id === DEFAULT_FIRESTORE_DATABASE || DATABASE_ID.test(id);
}

/** The database every store uses; unset or blank means `(default)`. */
export function firestoreDatabaseId(env: NodeJS.ProcessEnv = process.env): string {
  return env.FIRESTORE_DATABASE_ID?.trim() || DEFAULT_FIRESTORE_DATABASE;
}

/** The boot log line naming the database, or null when no store uses Firestore. */
export function firestoreDatabaseLine(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.FIRESTORE_PROJECT_ID) return null;
  return `Firestore database: ${firestoreDatabaseId(env)}`;
}

export function createFirestore(
  projectId: string,
  env: NodeJS.ProcessEnv = process.env
): Firestore {
  return new Firestore({ projectId, databaseId: firestoreDatabaseId(env) });
}
