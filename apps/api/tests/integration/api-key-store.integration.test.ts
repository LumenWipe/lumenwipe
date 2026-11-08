import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { Firestore, Timestamp } from "@google-cloud/firestore";
import { FirestoreApiKeyStore, generateApiKey, hashApiKey } from "@/auth/api-key-store";
import { runApiKeyStoreContract } from "../support/api-key-store-contract";

// Runs only against the Firestore emulator, never a real project: start one and export
// FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8787) before `bun run test:integration`.
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

const firestore = EMULATOR ? new Firestore({ projectId: "lumenwipe-emulator" }) : null;

afterAll(async () => {
  await firestore?.terminate();
});

if (EMULATOR) {
  runApiKeyStoreContract(
    "FirestoreApiKeyStore (emulator)",
    () => new FirestoreApiKeyStore(firestore!, `apiKeys-${randomBytes(6).toString("hex")}`)
  );

  test("a document written before label and network scopes resolves unscoped", async () => {
    const collection = `apiKeys-${randomBytes(6).toString("hex")}`;
    const raw = generateApiKey();
    await firestore!.collection(collection).doc(hashApiKey(raw)).create({
      owner: "GOWNER",
      createdAt: Timestamp.now(),
      revokedAt: null,
      rotatedFrom: null,
      rateLimit: null,
    });
    const record = await new FirestoreApiKeyStore(firestore!, collection).resolve(raw);
    expect(record).toMatchObject({
      owner: "GOWNER",
      label: null,
      networks: null,
      lastUsedAt: null,
    });
  });
} else {
  describe.skip("ApiKeyStore contract: FirestoreApiKeyStore (emulator)", () => {});
}
