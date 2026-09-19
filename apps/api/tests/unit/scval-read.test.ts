import { expect, test } from "bun:test";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { addressOf, bigOf, collectAccounts, CONTRACT_ID } from "@/lib/stellar/scval-read";

const CONTRACT = Address.contract(Buffer.alloc(32, 1)).toString();
const ACCOUNT = Keypair.random().publicKey();
const OTHER_ACCOUNT = Keypair.random().publicKey();

test("addressOf reads an address ScVal, null for anything else", () => {
  expect(addressOf(nativeToScVal(CONTRACT, { type: "address" }))).toBe(CONTRACT);
  expect(addressOf(nativeToScVal(5, { type: "i128" }))).toBeNull();
});

test("bigOf reads an integer ScVal as a bigint, null for anything else", () => {
  expect(bigOf(nativeToScVal(500n, { type: "i128" }))).toBe(500n);
  expect(bigOf(nativeToScVal(CONTRACT, { type: "address" }))).toBeNull();
});

test("CONTRACT_ID matches only a C... address", () => {
  expect(CONTRACT_ID.test(CONTRACT)).toBe(true);
  expect(CONTRACT_ID.test(ACCOUNT)).toBe(false);
});

test("collectAccounts throws on any G-account other than the one being closed, anywhere nested", () => {
  expect(() => collectAccounts(nativeToScVal(ACCOUNT, { type: "address" }), ACCOUNT)).not.toThrow();
  expect(() =>
    collectAccounts(xdr.ScVal.scvVec([nativeToScVal(OTHER_ACCOUNT, { type: "address" })]), ACCOUNT)
  ).toThrow("the swap names an account other than the one being closed");
});
