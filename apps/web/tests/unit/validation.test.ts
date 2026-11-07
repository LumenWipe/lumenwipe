import { test, expect } from "bun:test";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import {
  addressErrorMessage,
  isValidGAddress,
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
