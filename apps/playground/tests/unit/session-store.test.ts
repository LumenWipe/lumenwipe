import { test, expect, beforeEach } from "bun:test";
import {
  createSession,
  loadSession,
  saveSession,
  deleteSession,
} from "@/lib/session-store";

beforeEach(() => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.NODE_ENV = "test";
});

test("create → load round-trips the session in the dev fallback store", async () => {
  const session = await createSession({
    demoPublic: "GDEMO",
    encDemoSecret: "enc",
    ephemeralIssuers: [],
    completedMessSteps: [],
    demolishLog: [],
    demolishDone: false,
    fundRareAssets: [],
    offerCount: 0,
    dataEntryCount: 0,
  });
  const loaded = await loadSession(session.id);
  expect(loaded?.demoPublic).toBe("GDEMO");
});

test("save refreshes the stored session", async () => {
  const session = await createSession({
    demoPublic: "GDEMO",
    encDemoSecret: "enc",
    ephemeralIssuers: [],
    completedMessSteps: [],
    demolishLog: [],
    demolishDone: false,
    fundRareAssets: [],
    offerCount: 0,
    dataEntryCount: 0,
  });
  session.completedMessSteps.push("SETUP");
  await saveSession(session);
  const loaded = await loadSession(session.id);
  expect(loaded?.completedMessSteps).toEqual(["SETUP"]);
});

test("delete removes the session", async () => {
  const session = await createSession({
    demoPublic: "GDEMO",
    encDemoSecret: "enc",
    ephemeralIssuers: [],
    completedMessSteps: [],
    demolishLog: [],
    demolishDone: false,
    fundRareAssets: [],
    offerCount: 0,
    dataEntryCount: 0,
  });
  await deleteSession(session.id);
  expect(await loadSession(session.id)).toBeNull();
});

test("loading an unknown id returns null", async () => {
  expect(await loadSession("nonexistent")).toBeNull();
});
