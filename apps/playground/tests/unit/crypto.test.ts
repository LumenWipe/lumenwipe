import { test, expect, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, PlaygroundConfigError } from "@/lib/crypto";

beforeEach(() => {
  process.env.PLAYGROUND_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

// Deliberately not a syntactically valid Stellar strkey - this function encrypts an
// arbitrary string, so the test fixture doesn't need to look like a real secret key, and a
// string that decodes to a real keypair invites exactly the confusion a secret scanner
// exists to catch.
const TEST_PLAINTEXT = "playground-crypto-test-fixture-not-a-real-secret-000000";

test("encrypt/decrypt › round-trip recovers the plaintext", () => {
  expect(decryptSecret(encryptSecret(TEST_PLAINTEXT))).toBe(TEST_PLAINTEXT);
});

test("encrypt › same plaintext yields different ciphertexts (random IV)", () => {
  expect(encryptSecret(TEST_PLAINTEXT)).not.toBe(encryptSecret(TEST_PLAINTEXT));
});

test("decrypt › tampered ciphertext fails the auth tag", () => {
  const payload = encryptSecret("supersecret");
  const [iv, tag, data] = payload.split(":");
  const flipped = (parseInt(data[0], 16) ^ 1).toString(16) + data.slice(1);
  expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
});

test("decrypt › malformed payload rejected", () => {
  expect(() => decryptSecret("not-a-payload")).toThrow("Malformed encrypted payload");
});

test("missing env key › throws PlaygroundConfigError", () => {
  delete process.env.PLAYGROUND_ENCRYPTION_KEY;
  expect(() => encryptSecret("x")).toThrow(PlaygroundConfigError);
});

test("invalid env key length › throws PlaygroundConfigError", () => {
  process.env.PLAYGROUND_ENCRYPTION_KEY = "abcd";
  expect(() => encryptSecret("x")).toThrow(PlaygroundConfigError);
});
