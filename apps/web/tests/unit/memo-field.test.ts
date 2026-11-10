import { afterEach, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { activeRegistry, bundledRegistry, setRegistry } from "@/lib/exchange-registry";
import { confirmedMemo, memoBytes, memoField, refusesIdMemoEdit } from "@/lib/plan/memo-field";

const UNLISTED = Keypair.random().publicKey();
const original = activeRegistry();
const listed = (type: "text" | "id") => {
  const entry = original.entries.find((e) => e.requiresMemo && e.memoType === type);
  if (!entry) throw new Error(`no ${type} exchange in the registry`);
  return entry;
};
const TEXT_EXCHANGE = listed("text");
const ID_EXCHANGE = listed("id");

afterEach(() => setRegistry(original));

/** Serves the bundled registry plus one exchange it does not list, whatever an earlier test or
 *  file left in module state. */
function serveSnapshotOnly(entry: { requiresMemo: boolean; memoType: "text" | "id" | "hash" }) {
  const address = Keypair.random().publicKey();
  const bundled = bundledRegistry();
  setRegistry({
    ...bundled,
    served: true,
    entries: [
      ...bundled.entries,
      { address, name: "Newly Listed", domain: "example.com", requiresMediator: false, ...entry },
    ],
  });
  return address;
}

test("an ASCII text memo is accepted and counted in bytes", () => {
  const field = memoField(UNLISTED, "mainnet", "hello", "text", false);
  expect(field).toMatchObject({ type: "text", error: null, fact: "ok", bytes: 5 });
  expect(field.memoType).toBe("text");
});

test("a text memo of exactly 28 bytes passes and 29 does not", () => {
  expect(memoField(UNLISTED, "mainnet", "a".repeat(28), "text", false).error).toBeNull();
  const over = memoField(UNLISTED, "mainnet", "a".repeat(29), "text", false);
  expect(over.fact).toBe("invalid");
  expect(over.error).toContain("29 bytes");
});

test("a multibyte memo short in characters but over 28 bytes is refused with its byte count", () => {
  const memo = "€".repeat(10); // 10 characters, 30 bytes
  expect(memo.length).toBeLessThanOrEqual(28);
  const field = memoField(UNLISTED, "mainnet", memo, "text", false);
  expect(field.bytes).toBe(30);
  expect(field.fact).toBe("invalid");
  expect(field.error).toBe("This memo is 30 bytes. A text memo holds at most 28.");
  expect(memoField(UNLISTED, "mainnet", "€".repeat(9), "text", false).error).toBeNull();
});

test("an id memo is bounded by 2^64 - 1", () => {
  expect(memoField(UNLISTED, "mainnet", "18446744073709551615", "id", false).error).toBeNull();
  expect(memoField(UNLISTED, "mainnet", "18446744073709551616", "id", false).error).toContain(
    "at most 18446744073709551615"
  );
  expect(memoField(UNLISTED, "mainnet", "0", "id", false).error).toBeNull();
});

test("an id memo refuses leading zeros instead of dropping them", () => {
  const field = memoField(UNLISTED, "mainnet", "007", "id", false);
  expect(field.fact).toBe("invalid");
  expect(field.error).toBe("An id memo cannot start with 0.");
  expect(field.normalized).toBe("007");
});

test("an id memo is digits only, and the value is never stripped", () => {
  const field = memoField(UNLISTED, "mainnet", "12a4", "id", false);
  expect(field.error).toBe("An id memo is digits only.");
  expect(field.normalized).toBe("12a4");
  expect(refusesIdMemoEdit("12a")).toBe(true);
  expect(refusesIdMemoEdit("-1")).toBe(true);
  expect(refusesIdMemoEdit("1e5")).toBe(true);
  expect(refusesIdMemoEdit(" 123 ")).toBe(false);
});

test("a required memo left empty is missing, with the exchange's wording", () => {
  const field = memoField(TEXT_EXCHANGE.address, "mainnet", "  ", "text", false);
  expect(field).toMatchObject({
    required: true,
    fact: "missing",
    error: "This exchange needs a memo.",
    memoType: null,
  });
});

test("an optional memo left empty is fine and carries no type", () => {
  expect(memoField(UNLISTED, "mainnet", "", "id", false)).toMatchObject({
    fact: "ok",
    error: null,
    memoType: null,
  });
});

test("a non-empty optional memo is validated too", () => {
  expect(memoField(UNLISTED, "mainnet", "x".repeat(40), "text", false).fact).toBe("invalid");
});

test("the registry's memo type wins over the user's choice", () => {
  const field = memoField(ID_EXCHANGE.address, "mainnet", "12345", "text", false);
  expect(field).toMatchObject({ type: "id", typeFixed: true, memoType: "id", error: null });
  expect(memoField(ID_EXCHANGE.address, "mainnet", "abc", "text", false).error).toBe(
    "An id memo is digits only."
  );
  expect(memoField(TEXT_EXCHANGE.address, "mainnet", "abc", "id", false)).toMatchObject({
    type: "text",
    error: null,
  });
});

test("the registry's type wins even for a listed exchange that needs no memo", () => {
  setRegistry({
    ...original,
    entries: original.entries.map((e) =>
      e.address === ID_EXCHANGE.address ? { ...e, requiresMemo: false } : e
    ),
  });
  expect(memoField(ID_EXCHANGE.address, "mainnet", "abc", "text", false)).toMatchObject({
    type: "id",
    required: false,
    fact: "invalid",
  });
});

test("an unlisted destination takes the chosen type", () => {
  expect(memoField(UNLISTED, "mainnet", "12", "id", false).memoType).toBe("id");
  expect(memoField(UNLISTED, "mainnet", "12", "text", false).memoType).toBe("text");
  expect(memoField(UNLISTED, "mainnet", "12", "id", false).typeFixed).toBe(false);
});

test("confirmedMemo sends the type the user chose for an exchange only the served registry lists", () => {
  const address = serveSnapshotOnly({ requiresMemo: true, memoType: "id" });
  expect(confirmedMemo(address, "mainnet", "4411", "text")).toEqual({
    memo: "4411",
    memoType: "text",
  });
  expect(confirmedMemo(address, "mainnet", "4411", "id")).toEqual({ memo: "4411", memoType: "id" });
});

test("confirmedMemo keeps a bundled exchange's own type over the user's", () => {
  setRegistry(bundledRegistry());
  expect(confirmedMemo(ID_EXCHANGE.address, "mainnet", "4411", "text")).toEqual({
    memo: "4411",
    memoType: "id",
  });
});

test("an exchange only the served registry lists has its type stated by the user", () => {
  const address = serveSnapshotOnly({ requiresMemo: true, memoType: "id" });
  expect(memoField(address, "mainnet", "4411", "text", false)).toMatchObject({
    listing: "served",
    typeFixed: false,
    typeChosen: false,
    servedType: "id",
    fact: "type-unchosen",
  });
  expect(memoField(address, "mainnet", "", "text", false).fact).toBe("type-unchosen");
  expect(memoField(address, "mainnet", "abc", "text", true)).toMatchObject({
    type: "text",
    memoType: "text",
    error: null,
    fact: "type-mismatch",
  });
  expect(memoField(address, "mainnet", "4411", "id", true)).toMatchObject({
    type: "id",
    fact: "ok",
  });
  expect(memoField(address, "mainnet", "", "id", true).fact).toBe("missing");
});

test("an optional memo left empty needs no type for an exchange only the served registry lists", () => {
  const address = serveSnapshotOnly({ requiresMemo: false, memoType: "id" });
  expect(memoField(address, "mainnet", "", "text", false).fact).toBe("ok");
  expect(memoField(address, "mainnet", "abc", "text", false).fact).toBe("type-unchosen");
});

test("a hash memo from the served registry alone is still refused, with no choice to make", () => {
  const address = serveSnapshotOnly({ requiresMemo: true, memoType: "hash" });
  expect(memoField(address, "mainnet", "abc", "text", false)).toMatchObject({
    type: "hash",
    typeFixed: true,
    typeChosen: true,
    fact: "invalid",
  });
});

test("a bundled exchange is fixed and an unlisted destination needs no choice made", () => {
  setRegistry(bundledRegistry());
  expect(memoField(ID_EXCHANGE.address, "mainnet", "4411", "text", false)).toMatchObject({
    listing: "bundled",
    typeFixed: true,
    typeChosen: true,
    servedType: null,
  });
  expect(memoField(UNLISTED, "mainnet", "abc", "text", false)).toMatchObject({
    listing: "unlisted",
    typeChosen: true,
    fact: "ok",
  });
});

test("a hash memo from the registry is refused, since none can be sent", () => {
  setRegistry({
    ...original,
    entries: original.entries.map((e) =>
      e.address === TEXT_EXCHANGE.address ? { ...e, memoType: "hash" as const } : e
    ),
  });
  expect(memoField(TEXT_EXCHANGE.address, "mainnet", "abc", "text", false).fact).toBe("invalid");
});

test("the memo that goes on chain is the typed one with only the outer whitespace removed", () => {
  expect(memoField(UNLISTED, "mainnet", "  a b  ", "text", false).normalized).toBe("a b");
  expect(memoBytes("é")).toBe(2);
});

test.each([
  ["7 emoji, 28 bytes", "🚀".repeat(7), "text", true],
  ["8 emoji, 32 bytes", "🚀".repeat(8), "text", false],
  ["9 CJK characters, 27 bytes", "日".repeat(9), "text", true],
  ["10 CJK characters, 30 bytes", "日".repeat(10), "text", false],
  ["a numeric id", "12345678", "id", true],
  ["a negative id", "-1", "id", false],
  ["a fractional id", "1.5", "id", false],
  ["letters as an id", "abc", "id", false],
] as const)("%s", (_, memo, type, ok) => {
  expect(memoField(UNLISTED, "mainnet", memo, type, false).error === null).toBe(ok);
});

test("confirmedMemo uses the registry type for a listed exchange, whatever was stored", () => {
  expect(confirmedMemo(ID_EXCHANGE.address, "mainnet", "4411", "text")).toEqual({
    memo: "4411",
    memoType: "id",
  });
  expect(confirmedMemo(TEXT_EXCHANGE.address, "mainnet", "4411", "id")).toEqual({
    memo: "4411",
    memoType: "text",
  });
});

test("confirmedMemo uses the stored type for an unlisted destination", () => {
  expect(confirmedMemo(UNLISTED, "mainnet", "4411", "id")).toEqual({
    memo: "4411",
    memoType: "id",
  });
  expect(confirmedMemo(UNLISTED, "mainnet", "4411", "text")).toEqual({
    memo: "4411",
    memoType: "text",
  });
});

test("confirmedMemo falls back to text when no type was stored", () => {
  expect(confirmedMemo(UNLISTED, "mainnet", "4411", null)).toEqual({
    memo: "4411",
    memoType: "text",
  });
});

test("confirmedMemo is null without a memo and trims like the plan page", () => {
  expect(confirmedMemo(UNLISTED, "mainnet", null, "id")).toBeNull();
  expect(confirmedMemo(UNLISTED, "mainnet", "   ", "id")).toBeNull();
  expect(confirmedMemo(UNLISTED, "mainnet", " 4411 ", "id")).toEqual({
    memo: "4411",
    memoType: "id",
  });
  expect(confirmedMemo(UNLISTED, "mainnet", " 4411 ", "id")?.memo).toBe(
    memoField(UNLISTED, "mainnet", " 4411 ", "id", false).normalized
  );
});

test("confirmedMemo does not look up a destination that is not an account address", () => {
  expect(confirmedMemo("not-an-address", "mainnet", "4411", "id")).toEqual({
    memo: "4411",
    memoType: "id",
  });
});
