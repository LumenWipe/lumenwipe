import { test, expect } from "bun:test";
import { hash, StrKey } from "@stellar/stellar-sdk";
import { verifyHashXPreimage, InvalidPreimageError } from "@/lib/stellar/hash-x";

function signerKeyFor(preimageHex: string): string {
  return StrKey.encodeSha256Hash(hash(Buffer.from(preimageHex, "hex")));
}

test("verifyHashXPreimage › a correct preimage returns the matching preimage bytes", () => {
  const preimageHex = "deadbeef";
  const signerKey = signerKeyFor(preimageHex);

  const preimage = verifyHashXPreimage(preimageHex, signerKey);

  expect(preimage.toString("hex")).toBe(preimageHex);
});

test("verifyHashXPreimage › a preimage that doesn't hash to the signer's key is rejected", () => {
  const signerKey = signerKeyFor("deadbeef");

  expect(() => verifyHashXPreimage("cafebabe", signerKey)).toThrow(InvalidPreimageError);
  expect(() => verifyHashXPreimage("cafebabe", signerKey)).toThrow(/does not hash/i);
});

test("verifyHashXPreimage › non-hex input is rejected before hashing", () => {
  const signerKey = signerKeyFor("deadbeef");

  expect(() => verifyHashXPreimage("not hex!", signerKey)).toThrow(InvalidPreimageError);
  expect(() => verifyHashXPreimage("not hex!", signerKey)).toThrow(/hex-encoded/i);
});

test("verifyHashXPreimage › odd-length hex is rejected", () => {
  const signerKey = signerKeyFor("deadbeef");

  expect(() => verifyHashXPreimage("abc", signerKey)).toThrow(InvalidPreimageError);
});

test("verifyHashXPreimage › empty input is rejected", () => {
  const signerKey = signerKeyFor("deadbeef");

  expect(() => verifyHashXPreimage("", signerKey)).toThrow(InvalidPreimageError);
  expect(() => verifyHashXPreimage("   ", signerKey)).toThrow(InvalidPreimageError);
});

test("verifyHashXPreimage › a preimage longer than 64 bytes is rejected", () => {
  const longHex = "ab".repeat(65);
  const signerKey = signerKeyFor(longHex);

  expect(() => verifyHashXPreimage(longHex, signerKey)).toThrow(InvalidPreimageError);
  expect(() => verifyHashXPreimage(longHex, signerKey)).toThrow(/too long/i);
});

test("verifyHashXPreimage › a 64-byte preimage (the SDK's own bound) is accepted", () => {
  const hex64 = "ab".repeat(64);
  const signerKey = signerKeyFor(hex64);

  expect(verifyHashXPreimage(hex64, signerKey).length).toBe(64);
});
