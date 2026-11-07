import { afterEach, expect, test } from "bun:test";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { activeRegistry, setRegistry } from "@/lib/exchange-registry";
import {
  destinationKind,
  isoDay,
  memoLine,
  memoSegments,
  relayRoute,
} from "@/lib/plan/destination-kind";

const WALLET = Keypair.random().publicKey();
const before = activeRegistry();
const exchange = before.entries.find((e) => e.requiresMediator && e.requiresMemo)!;

afterEach(() => setRegistry(before));

test("a listed exchange names itself, its memo rule, the relay and the day the list was checked", () => {
  expect(destinationKind(exchange.address, { acknowledgedFor: null })).toEqual({
    kind: "exchange",
    name: exchange.name,
    memoRequired: true,
    route: "relay",
    lastVerified: before.lastVerified.slice(0, 10),
  });
});

test("the registry date reads as YYYY-MM-DD whatever form or timezone it was stored in", () => {
  setRegistry({ ...before, lastVerified: "2026-10-10T23:30:00-05:00" });
  const kind = destinationKind(exchange.address, { acknowledgedFor: null });
  expect(kind.kind === "exchange" && kind.lastVerified).toBe("2026-10-10");
  expect(isoDay("2026-01-02")).toBe("2026-01-02");
});

test("an unlisted address the user confirmed is a confirmed wallet", () => {
  expect(destinationKind(WALLET, { acknowledgedFor: WALLET })).toEqual({
    kind: "confirmed-wallet",
  });
});

test("a confirmation given for another address does not carry over", () => {
  const other = Keypair.random().publicKey();
  expect(destinationKind(WALLET, { acknowledgedFor: other })).toEqual({
    kind: "wallet",
  });
  expect(destinationKind(WALLET, { acknowledgedFor: null })).toEqual({
    kind: "wallet",
  });
});

test("the memo line is none, or the type and the exact value", () => {
  expect(memoLine(null)).toEqual({ label: "none", value: null, bytes: null });
  expect(memoLine({ memo: "abc", memoType: "text" })).toEqual({
    label: "text",
    value: "abc",
    bytes: 3,
  });
  expect(memoLine({ memo: "7", memoType: "id" })).toEqual({ label: "id", value: "7", bytes: null });
  const hash = "ab".repeat(32);
  expect(memoLine({ memo: hash, memoType: "hash" }).value).toBe(hash);
});

test("a text memo counts UTF-8 bytes, so inner spaces and invisible characters show", () => {
  expect(memoLine({ memo: "a b", memoType: "text" }).bytes).toBe(3);
  expect(memoLine({ memo: "a​b", memoType: "text" }).bytes).toBe(5);
  expect(memoLine({ memo: "é", memoType: "text" }).bytes).toBe(2);
});

test("the relay route is the registry's, as verify() reads it", () => {
  const direct = Keypair.random().publicKey();
  const unbacked = Keypair.random().publicKey();
  const served = {
    name: "Served",
    domain: "example.com",
    requiresMemo: true,
    memoType: "text" as const,
  };
  setRegistry({
    ...before,
    entries: [
      ...before.entries,
      { ...served, address: direct, requiresMediator: false },
      { ...served, address: unbacked, requiresMediator: true },
    ],
  });
  expect(relayRoute(exchange.address)).toBe("relay");
  expect(relayRoute(direct)).toBe("direct");
  // A served entry may ask for the relay but cannot enable it: verify() refuses the direct merge.
  expect(relayRoute(unbacked)).toBe("refused");
  expect(relayRoute(WALLET)).toBe("direct");
});

test("a muxed address of a listed exchange is not shown as that exchange", () => {
  const muxed = new MuxedAccount(new Account(exchange.address, "0"), "42").accountId();
  expect(muxed.startsWith("M")).toBe(true);
  expect(destinationKind(muxed, { acknowledgedFor: null })).toEqual({ kind: "wallet" });
});

test("control and format characters become visible code points, the rest stays as typed", () => {
  const value = "a\u0007b\u200Bc\u200Fd\u202Ae\u2066f\uFEFFg h";
  const segments = memoSegments(value);
  expect(segments.filter((s) => s.escaped).map((s) => s.text)).toEqual([
    "\\u{0007}",
    "\\u{200B}",
    "\\u{200F}",
    "\\u{202A}",
    "\\u{2066}",
    "\\u{FEFF}",
  ]);
  expect(
    segments
      .filter((s) => !s.escaped)
      .map((s) => s.text)
      .join("")
  ).toBe("abcdefg h");
  expect(memoSegments("plain text")).toEqual([{ text: "plain text", escaped: false }]);
});
