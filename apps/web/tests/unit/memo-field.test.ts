import { afterEach, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { activeRegistry, setRegistry } from "@/lib/exchange-registry";
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

test("an ASCII text memo is accepted and counted in bytes", () => {
  const field = memoField(UNLISTED, "hello", "text");
  expect(field).toMatchObject({ type: "text", error: null, fact: "ok", bytes: 5 });
  expect(field.memoType).toBe("text");
});

test("a text memo of exactly 28 bytes passes and 29 does not", () => {
  expect(memoField(UNLISTED, "a".repeat(28), "text").error).toBeNull();
  const over = memoField(UNLISTED, "a".repeat(29), "text");
  expect(over.fact).toBe("invalid");
  expect(over.error).toContain("29 bytes");
});

test("a multibyte memo short in characters but over 28 bytes is refused with its byte count", () => {
  const memo = "€".repeat(10); // 10 characters, 30 bytes
  expect(memo.length).toBeLessThanOrEqual(28);
  const field = memoField(UNLISTED, memo, "text");
  expect(field.bytes).toBe(30);
  expect(field.fact).toBe("invalid");
  expect(field.error).toBe("This memo is 30 bytes. A text memo holds at most 28.");
  expect(memoField(UNLISTED, "€".repeat(9), "text").error).toBeNull();
});

test("an id memo is bounded by 2^64 - 1", () => {
  expect(memoField(UNLISTED, "18446744073709551615", "id").error).toBeNull();
  expect(memoField(UNLISTED, "18446744073709551616", "id").error).toContain(
    "at most 18446744073709551615"
  );
  expect(memoField(UNLISTED, "0", "id").error).toBeNull();
});

test("an id memo refuses leading zeros instead of dropping them", () => {
  const field = memoField(UNLISTED, "007", "id");
  expect(field.fact).toBe("invalid");
  expect(field.error).toBe("An id memo cannot start with 0.");
  expect(field.normalized).toBe("007");
});

test("an id memo is digits only, and the value is never stripped", () => {
  const field = memoField(UNLISTED, "12a4", "id");
  expect(field.error).toBe("An id memo is digits only.");
  expect(field.normalized).toBe("12a4");
  expect(refusesIdMemoEdit("12a")).toBe(true);
  expect(refusesIdMemoEdit("-1")).toBe(true);
  expect(refusesIdMemoEdit("1e5")).toBe(true);
  expect(refusesIdMemoEdit(" 123 ")).toBe(false);
});

test("a required memo left empty is missing, with the exchange's wording", () => {
  const field = memoField(TEXT_EXCHANGE.address, "  ", "text");
  expect(field).toMatchObject({
    required: true,
    fact: "missing",
    error: "This exchange needs a memo.",
    memoType: null,
  });
});

test("an optional memo left empty is fine and carries no type", () => {
  expect(memoField(UNLISTED, "", "id")).toMatchObject({ fact: "ok", error: null, memoType: null });
});

test("a non-empty optional memo is validated too", () => {
  expect(memoField(UNLISTED, "x".repeat(40), "text").fact).toBe("invalid");
});

test("the registry's memo type wins over the user's choice", () => {
  const field = memoField(ID_EXCHANGE.address, "12345", "text");
  expect(field).toMatchObject({ type: "id", typeFixed: true, memoType: "id", error: null });
  expect(memoField(ID_EXCHANGE.address, "abc", "text").error).toBe("An id memo is digits only.");
  expect(memoField(TEXT_EXCHANGE.address, "abc", "id")).toMatchObject({
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
  expect(memoField(ID_EXCHANGE.address, "abc", "text")).toMatchObject({
    type: "id",
    required: false,
    fact: "invalid",
  });
});

test("an unlisted destination takes the chosen type", () => {
  expect(memoField(UNLISTED, "12", "id").memoType).toBe("id");
  expect(memoField(UNLISTED, "12", "text").memoType).toBe("text");
  expect(memoField(UNLISTED, "12", "id").typeFixed).toBe(false);
});

test("a hash memo from the registry is refused, since none can be sent", () => {
  setRegistry({
    ...original,
    entries: original.entries.map((e) =>
      e.address === TEXT_EXCHANGE.address ? { ...e, memoType: "hash" as const } : e
    ),
  });
  expect(memoField(TEXT_EXCHANGE.address, "abc", "text").fact).toBe("invalid");
});

test("the memo that goes on chain is the typed one with only the outer whitespace removed", () => {
  expect(memoField(UNLISTED, "  a b  ", "text").normalized).toBe("a b");
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
  expect(memoField(UNLISTED, memo, type).error === null).toBe(ok);
});

test("confirmedMemo uses the registry type for a listed exchange, whatever was stored", () => {
  expect(confirmedMemo(ID_EXCHANGE.address, "4411", "text")).toEqual({
    memo: "4411",
    memoType: "id",
  });
  expect(confirmedMemo(TEXT_EXCHANGE.address, "4411", "id")).toEqual({
    memo: "4411",
    memoType: "text",
  });
});

test("confirmedMemo uses the stored type for an unlisted destination", () => {
  expect(confirmedMemo(UNLISTED, "4411", "id")).toEqual({ memo: "4411", memoType: "id" });
  expect(confirmedMemo(UNLISTED, "4411", "text")).toEqual({ memo: "4411", memoType: "text" });
});

test("confirmedMemo falls back to text when no type was stored", () => {
  expect(confirmedMemo(UNLISTED, "4411", null)).toEqual({ memo: "4411", memoType: "text" });
});

test("confirmedMemo is null without a memo and trims like the plan page", () => {
  expect(confirmedMemo(UNLISTED, null, "id")).toBeNull();
  expect(confirmedMemo(UNLISTED, "   ", "id")).toBeNull();
  expect(confirmedMemo(UNLISTED, " 4411 ", "id")).toEqual({ memo: "4411", memoType: "id" });
  expect(confirmedMemo(UNLISTED, " 4411 ", "id")?.memo).toBe(
    memoField(UNLISTED, " 4411 ", "id").normalized
  );
});

test("confirmedMemo does not look up a destination that is not an account address", () => {
  expect(confirmedMemo("not-an-address", "4411", "id")).toEqual({ memo: "4411", memoType: "id" });
});
