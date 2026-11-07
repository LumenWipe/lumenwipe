import { expect, test } from "bun:test";
import { Account, Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import {
  addressErrorMessage,
  containsSecretKey,
  couldBeSecretKey,
  MUXED_ADDRESS_MESSAGE,
} from "@/lib/utils/validation";

// Synthetic: the shape of a secret seed with a checksum that does not match, never a real key.
const SECRET_SHAPED = "S" + "A".repeat(55);
const groupsOf = (value: string): string => value.match(/.{1,4}/g)!.join(" ");

/** A deterministic stream of bytes, so the generated addresses are the same on every run. */
function seededBytes(seed: number): (n: number) => Buffer {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return (n) => Buffer.from(Array.from({ length: n }, () => next() & 0xff));
}

const bytes = seededBytes(388);
const MUXED = Array.from({ length: 400 }, () => {
  const account = Keypair.fromRawEd25519Seed(bytes(32)).publicKey();
  const id = BigInt(`0x${bytes(8).toString("hex")}`).toString();
  return new MuxedAccount(new Account(account, "1"), id).accountId();
});

test("the reported muxed address is not taken for a secret key", () => {
  const reported = "MDGTZ6GSXM6CRQAS2VGIVTSGE44XPOMDQ7RHOZ5ZB5ZSJ6VR2G33KAAAAAAAAAAABBRAO";
  expect(couldBeSecretKey(reported)).toBe(false);
  expect(addressErrorMessage(reported)).toBe(MUXED_ADDRESS_MESSAGE);
});

test("no generated muxed address is refused, and each is explained as muxed", () => {
  // The old unanchored check matched inside a large share of these.
  expect(MUXED.some((m) => /S[A-Z2-7]{55}/.test(m))).toBe(true);
  for (const muxed of MUXED) {
    expect(couldBeSecretKey(muxed)).toBe(false);
    expect(addressErrorMessage(muxed)).toBe(MUXED_ADDRESS_MESSAGE);
  }
});

test("account and contract addresses pass", () => {
  const contract = StrKey.encodeContract(bytes(32));
  for (const value of [Keypair.random().publicKey(), contract, ` ${contract}\n`]) {
    expect(couldBeSecretKey(value)).toBe(false);
    expect(containsSecretKey(value)).toBe(false);
  }
});

test.each([
  ["alone", SECRET_SHAPED],
  ["after a label", `key: ${SECRET_SHAPED}`],
  ["in quotes", `"${SECRET_SHAPED}"`],
  ["split into groups", groupsOf(SECRET_SHAPED)],
  ["split after a label", `key: ${groupsOf(SECRET_SHAPED)}`],
  ["on its own line", `secret\n${SECRET_SHAPED}\n`],
])("a secret key %s is found", (_, value) => {
  expect(containsSecretKey(value)).toBe(true);
  expect(couldBeSecretKey(value)).toBe(true);
});

test("a run of base32 longer than a key is not one", () => {
  expect(containsSecretKey(`G${SECRET_SHAPED}`)).toBe(false);
  expect(containsSecretKey(`${SECRET_SHAPED}A`)).toBe(false);
});

test("an address field still refuses anything starting with S, but a memo-like word is not a key", () => {
  expect(couldBeSecretKey("SALARY")).toBe(true);
  expect(containsSecretKey("SALARY")).toBe(false);
});
