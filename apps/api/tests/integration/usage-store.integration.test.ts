import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { Firestore } from "@google-cloud/firestore";
import { FirestoreUsageStore, ownerDocId } from "@/metering/usage-store";

// Runs only against the Firestore emulator, never a real project: start one and export
// FIRESTORE_EMULATOR_HOST (e.g. 127.0.0.1:8787) before `bun run test:integration`.
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

const firestore = EMULATOR ? new Firestore({ projectId: "lumenwipe-emulator" }) : null;

afterAll(async () => {
  await firestore?.terminate();
});

const freshRoot = () => `usage-${randomBytes(6).toString("hex")}`;
const OWNER = "GOWNER";

describe.skipIf(!EMULATOR)("FirestoreUsageStore (emulator)", () => {
  test("counts survive a new store instance", async () => {
    const root = freshRoot();
    const first = new FirestoreUsageStore(firestore!, root);
    for (let i = 0; i < 3; i++)
      await first.increment(OWNER, "POST /v1/mainnet/submit", "2026-10-09");
    const restarted = new FirestoreUsageStore(firestore!, root);
    expect(await restarted.daily(OWNER, "2026-10-01")).toEqual([{ date: "2026-10-09", total: 3 }]);
  });

  test("concurrent requests never lose a count", async () => {
    const store = new FirestoreUsageStore(firestore!, freshRoot());
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.increment(OWNER, "GET /v1/mainnet/account/:address", "2026-10-09")
      )
    );
    expect(await store.daily(OWNER, "2026-10-09")).toEqual([{ date: "2026-10-09", total: 20 }]);
  });

  test("breaks the day down by route, keeping slashes and colons in the route name", async () => {
    const root = freshRoot();
    const store = new FirestoreUsageStore(firestore!, root);
    await store.increment(OWNER, "POST /v1/mainnet/submit", "2026-10-09");
    await store.increment(OWNER, "POST /v1/mainnet/submit", "2026-10-09");
    await store.increment(OWNER, "GET /v1/testnet/account/:address", "2026-10-09");
    const doc = await firestore!
      .collection(root)
      .doc(OWNER)
      .collection("daily")
      .doc("2026-10-09")
      .get();
    expect(doc.get("byRoute")).toEqual({
      "POST /v1/mainnet/submit": 2,
      "GET /v1/testnet/account/:address": 1,
    });
  });

  test("daily honours the start date and keeps owners apart, even awkward labels", async () => {
    const store = new FirestoreUsageStore(firestore!, freshRoot());
    await store.increment("team/a", "r", "2026-09-01");
    await store.increment("team/a", "r", "2026-10-09");
    await store.increment("..", "r", "2026-10-09");
    expect(await store.daily("team/a", "2026-10-01")).toEqual([{ date: "2026-10-09", total: 1 }]);
    expect(await store.daily("..", "2026-10-01")).toEqual([{ date: "2026-10-09", total: 1 }]);
    expect(await store.daily(OWNER, "2026-01-01")).toEqual([]);
    expect(ownerDocId("team/a")).not.toContain("/");
  });
});
