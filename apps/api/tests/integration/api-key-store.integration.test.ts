import { afterAll, describe } from "bun:test";
import { randomBytes } from "crypto";
import { Firestore } from "@google-cloud/firestore";
import { FirestoreApiKeyStore } from "@/auth/api-key-store";
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
} else {
  describe.skip("ApiKeyStore contract: FirestoreApiKeyStore (emulator)", () => {});
}
