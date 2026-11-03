import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { closeOwner, ensureCloseSession, saveCloseSession } from "@/lib/session/close-record";
import * as sessionStore from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";

let A = closeOwner("testnet", "GA");

let saved: ReturnType<typeof spyOn>;

beforeEach(() => {
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({ sourceAddress: "GB", destinationAddress: "GD", sessionId: "b" });
  A = closeOwner("testnet", "GA");
  saved = spyOn(sessionStore, "saveSession").mockImplementation(async () => {});
  spyOn(sessionStore, "loadSession").mockImplementation(async () => null);
});

afterEach(() => mock.restore());

test("a session is never saved for an account the store no longer holds", async () => {
  expect(await saveCloseSession(A)).toBeNull();
  expect(saved).not.toHaveBeenCalled();
});

test("a session is never put back for an account the store no longer holds", async () => {
  expect(await ensureCloseSession(A)).toBeNull();
  expect(saved).not.toHaveBeenCalled();
});

test("a saved session is not handed to a run whose account the store no longer holds", async () => {
  spyOn(sessionStore, "loadSession").mockImplementation(async () => ({ id: "b" }) as never);
  expect(await ensureCloseSession(A)).toBeNull();
});

test("another network is another close", async () => {
  useDemolishStore.setState({ sourceAddress: "GA" });
  useNetworkStore.setState({ network: "mainnet" });
  expect(await ensureCloseSession(A)).toBeNull();
});

test("the owner's own close is put back and keeps its id", async () => {
  useDemolishStore.setState({ sourceAddress: "GA" });
  expect(await ensureCloseSession(A)).toBe("b");
  expect(saved).toHaveBeenCalledTimes(1);
});
