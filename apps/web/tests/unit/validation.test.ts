import { test, expect } from "bun:test";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import {
  addressErrorMessage,
  isValidGAddress,
  isValidMemo,
  isValidSecretKey,
  looksLikeSecretKey,
  MUXED_ADDRESS_MESSAGE,
  SECRET_KEY_WARNING,
} from "@/lib/utils/validation";

const kp = Keypair.random();
const VALID_ADDRESS = kp.publicKey();
const VALID_SECRET = kp.secret();

test("isValidGAddress › valid G-address", () => {
  expect(isValidGAddress(VALID_ADDRESS)).toBe(true);
});

test("isValidGAddress › empty string rejected", () => {
  expect(isValidGAddress("")).toBe(false);
});

test("isValidGAddress › random string rejected", () => {
  expect(isValidGAddress("INVALID_ADDRESS")).toBe(false);
});

test("isValidGAddress › too short rejected", () => {
  expect(isValidGAddress("G" + "A".repeat(10))).toBe(false);
});

test("isValidGAddress › S-secret rejected as address", () => {
  expect(isValidGAddress(VALID_SECRET)).toBe(false);
});

test("isValidGAddress › M-address (muxed) rejected", () => {
  expect(isValidGAddress("MA7QYNF7SOWQ3GLR2BGMZEHXR7CPLRNHIHA6DKPQ7GFPQZS7YJLCBIZD")).toBe(false);
});

test("isValidSecretKey › valid S-key", () => {
  expect(isValidSecretKey(VALID_SECRET)).toBe(true);
});

test("isValidSecretKey › G-address rejected as secret", () => {
  expect(isValidSecretKey(VALID_ADDRESS)).toBe(false);
});

test("isValidSecretKey › empty string rejected", () => {
  expect(isValidSecretKey("")).toBe(false);
});

test("isValidSecretKey › random string rejected", () => {
  expect(isValidSecretKey("SINVALID")).toBe(false);
});

// ─── text memo ───────────────────────────────────────────────────────────────

test("isValidMemo › text memo within 28 bytes is valid", () => {
  expect(isValidMemo("hello", "text")).toBe(true);
});

test("isValidMemo › text memo at exactly 28 ASCII bytes is valid", () => {
  expect(isValidMemo("a".repeat(28), "text")).toBe(true);
});

test("isValidMemo › text memo over 28 ASCII bytes is invalid", () => {
  expect(isValidMemo("a".repeat(29), "text")).toBe(false);
});

test("isValidMemo › empty text memo is invalid", () => {
  expect(isValidMemo("", "text")).toBe(false);
});

// Stellar limits memo_text to 28 UTF-8 bytes. Each emoji is 4 bytes in UTF-8
// but only 2 JavaScript code units (surrogate pair). A character-length check
// would allow 7 emoji (14 code units, 28 bytes) and 8 emoji (16 code units,
// 32 bytes), but the SDK enforces the byte limit so the latter must be rejected.
test("isValidMemo › text memo of 7 emoji (28 UTF-8 bytes) is valid", () => {
  expect(isValidMemo("🚀".repeat(7), "text")).toBe(true);
});

test("isValidMemo › text memo of 8 emoji (32 UTF-8 bytes) is invalid", () => {
  expect(isValidMemo("🚀".repeat(8), "text")).toBe(false);
});

// CJK characters are 3 UTF-8 bytes each (1 JS code unit).
// 9 CJK chars = 27 bytes (ok); 10 CJK chars = 30 bytes (too long).
test("isValidMemo › 9 CJK chars (27 UTF-8 bytes) is valid", () => {
  expect(isValidMemo("日".repeat(9), "text")).toBe(true);
});

test("isValidMemo › 10 CJK chars (30 UTF-8 bytes) is invalid", () => {
  expect(isValidMemo("日".repeat(10), "text")).toBe(false);
});

// ─── ID memo ─────────────────────────────────────────────────────────────────

test("isValidMemo › valid numeric ID memo", () => {
  expect(isValidMemo("12345678", "id")).toBe(true);
});

test("isValidMemo › non-numeric ID memo is invalid", () => {
  expect(isValidMemo("abc", "id")).toBe(false);
});

test("isValidMemo › ID memo with leading zeros is valid", () => {
  expect(isValidMemo("007", "id")).toBe(true);
});

test("isValidMemo › zero is a valid ID memo", () => {
  expect(isValidMemo("0", "id")).toBe(true);
});

test("isValidMemo › max uint64 ID memo is valid", () => {
  expect(isValidMemo("18446744073709551615", "id")).toBe(true);
});

test("isValidMemo › uint64 overflow ID memo is invalid", () => {
  expect(isValidMemo("18446744073709551616", "id")).toBe(false);
});

test("isValidMemo › empty ID memo is invalid", () => {
  expect(isValidMemo("", "id")).toBe(false);
});

test("isValidMemo › negative number ID memo is invalid", () => {
  expect(isValidMemo("-1", "id")).toBe(false);
});

test("isValidMemo › floating-point ID memo is invalid", () => {
  expect(isValidMemo("1.5", "id")).toBe(false);
});

// ─── hash memo ───────────────────────────────────────────────────────────────

test("isValidMemo › non-empty hash memo is valid", () => {
  expect(isValidMemo("abc123deadbeef", "hash")).toBe(true);
});

test("isValidMemo › empty hash memo is invalid", () => {
  expect(isValidMemo("", "hash")).toBe(false);
});

// Synthetic: secret-key shaped, with a checksum that does not match, so it is not a key.
const SECRET_SHAPED = "S" + "A".repeat(55);

test("the synthetic secret fixture is the shape of a seed but not a valid one", () => {
  expect(looksLikeSecretKey(SECRET_SHAPED)).toBe(true);
  expect(isValidSecretKey(SECRET_SHAPED)).toBe(false);
});

test("looksLikeSecretKey › only the full seed shape matches", () => {
  for (const value of ["", "S", SECRET_SHAPED.slice(0, 55), SECRET_SHAPED + "A", VALID_ADDRESS]) {
    expect(looksLikeSecretKey(value)).toBe(false);
  }
  expect(looksLikeSecretKey(SECRET_SHAPED.toLowerCase())).toBe(false);
});

test("addressErrorMessage › a secret-shaped value gets the warning, never echoed", () => {
  const message = addressErrorMessage(SECRET_SHAPED) as string;
  expect(message).toBe(SECRET_KEY_WARNING);
  expect(message).not.toContain("AAAA");
});

test("addressErrorMessage › a muxed address is explained, not called a typo", () => {
  const muxed = new MuxedAccount(new Account(VALID_ADDRESS, "1"), "42").accountId();
  expect(addressErrorMessage(muxed)).toBe(MUXED_ADDRESS_MESSAGE);
  const broken = muxed.slice(0, -1) + (muxed.endsWith("A") ? "B" : "A");
  expect(addressErrorMessage(broken)).toBe("A Stellar account address starts with G.");
});

test("addressErrorMessage › length, prefix, checksum and muxed messages are distinct", () => {
  const muxed = new MuxedAccount(new Account(VALID_ADDRESS, "1"), "7").accountId();
  const messages = [
    addressErrorMessage(VALID_ADDRESS.slice(0, 40)),
    addressErrorMessage("X" + VALID_ADDRESS.slice(1)),
    addressErrorMessage(VALID_ADDRESS.slice(0, -1) + (VALID_ADDRESS.endsWith("A") ? "B" : "A")),
    addressErrorMessage(muxed),
  ];
  expect(messages.every((m) => m !== null)).toBe(true);
  expect(new Set(messages).size).toBe(4);
});
