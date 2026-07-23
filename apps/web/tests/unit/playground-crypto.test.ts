import { test, expect, beforeEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, PlaygroundConfigError } from "@/lib/playground/crypto";

beforeEach(() => {
  process.env.PLAYGROUND_ENCRYPTION_KEY = randomBytes(32).toString("hex");
});

test("encrypt/decrypt › round-trip recovers the plaintext", () => {
  const secret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
  expect(decryptSecret(encryptSecret(secret))).toBe(secret);
});

test("encrypt › same plaintext yields different ciphertexts (random IV)", () => {
  const secret = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4";
  expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
});

test("decrypt › tampered ciphertext fails the auth tag", () => {
  const payload = encryptSecret("supersecret");
  const [iv, tag, data] = payload.split(":");
  const flipped = (parseInt(data[0], 16) ^ 1).toString(16) + data.slice(1);
  expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
});

test("decrypt › tampered auth tag fails", () => {
  const payload = encryptSecret("supersecret");
  const [iv, tag, data] = payload.split(":");
  const flipped = (parseInt(tag[0], 16) ^ 1).toString(16) + tag.slice(1);
  expect(() => decryptSecret(`${iv}:${flipped}:${data}`)).toThrow();
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
