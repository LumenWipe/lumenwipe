import { test, expect } from "bun:test";
import { Account, Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import {
  addressErrorMessage,
  addressProblem,
  type AddressProblem,
  isValidGAddress,
  isValidSecretKey,
  looksLikeSecretKey,
  MUXED_ADDRESS_MESSAGE,
  SECRET_KEY_WARNING,
} from "@/lib/utils/validation";

const kp = Keypair.random();
const VALID_ADDRESS = kp.publicKey();
const VALID_SECRET = kp.secret();
// Real strkeys: a made-up 56 or 69 character string fails the checksum and proves nothing.
const C_ADDRESS = StrKey.encodeContract(new Uint8Array(32).fill(7));
const W_ADDRESS = StrKey.encodeMuxedContract(new Uint8Array(40).fill(9));
const flipLast = (address: string): string =>
  address.slice(0, -1) + (address.endsWith("A") ? "B" : "A");

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

// The English text each refusal showed before the reasons moved into the locale dictionary. The app
// flow reads it unchanged, so these strings are never edited alongside a refactor.
const ENGLISH_REFUSALS: Record<AddressProblem, string> = {
  "secret-key":
    "That looks like a secret key. Never paste it here. LumenWipe only needs your public address (starts with G).",
  muxed: "This looks like a muxed address. Use the G address plus the memo your exchange shows.",
  contract:
    "This is a contract address (C...). Closing and analysing contract accounts is not supported yet. Use a Stellar account address (G...).",
  "muxed-contract":
    "This is a muxed contract address (W...). Closing and analysing contract accounts is not supported yet. Use a Stellar account address (G...).",
  prefix: "A Stellar account address starts with G.",
  length: "A Stellar account address has 56 characters.",
  checksum: "This address has a typo: its checksum does not match. Copy it again from the source.",
};

test("addressProblem › names the reason, and addressErrorMessage keeps the English text", () => {
  const muxed = new MuxedAccount(new Account(VALID_ADDRESS, "0"), "7").accountId();
  const typo = VALID_ADDRESS.slice(0, -1) + (VALID_ADDRESS.endsWith("A") ? "B" : "A");
  const cases: [string, AddressProblem][] = [
    [VALID_SECRET, "secret-key"],
    [muxed, "muxed"],
    [C_ADDRESS, "contract"],
    [W_ADDRESS, "muxed-contract"],
    ["XABC", "prefix"],
    ["GABC", "length"],
    [typo, "checksum"],
  ];
  expect(addressProblem(VALID_ADDRESS)).toBeNull();
  expect(addressErrorMessage(VALID_ADDRESS)).toBeNull();
  for (const [input, problem] of cases) {
    expect(addressProblem(input)).toBe(problem);
    expect(addressErrorMessage(input)).toBe(ENGLISH_REFUSALS[problem]);
  }
  expect(SECRET_KEY_WARNING).toBe(ENGLISH_REFUSALS["secret-key"]);
  expect(MUXED_ADDRESS_MESSAGE).toBe(ENGLISH_REFUSALS.muxed);
});

test("addressProblem › a contract or muxed contract address is named, a damaged one is a typo", () => {
  expect(isValidGAddress(C_ADDRESS)).toBe(false);
  expect(isValidGAddress(W_ADDRESS)).toBe(false);
  expect(addressProblem(C_ADDRESS)).toBe("contract");
  expect(addressProblem(W_ADDRESS)).toBe("muxed-contract");
  // Not a valid strkey of either kind, so it keeps the existing reasons.
  expect(addressProblem(flipLast(C_ADDRESS))).toBe("prefix");
  expect(addressProblem(flipLast(W_ADDRESS))).toBe("prefix");
});

test("addressErrorMessage › the contract messages never quote the address", () => {
  for (const address of [C_ADDRESS, W_ADDRESS]) {
    const message = addressErrorMessage(address) as string;
    expect(message).not.toContain(address);
    expect(message).not.toContain(address.slice(0, 12));
  }
  expect(addressErrorMessage(C_ADDRESS, "es")).toContain("contrato");
  expect(addressErrorMessage(W_ADDRESS, "es")).toContain("muxed");
});
