import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { buildAnalyzeHref } from "@/lib/utils/analyze-link";

const VALID_ADDRESS = Keypair.random().publicKey();

test("buildAnalyzeHref › valid address on mainnet", () => {
  expect(buildAnalyzeHref("mainnet", VALID_ADDRESS)).toBe(
    `/mainnet/analyze?source=${VALID_ADDRESS}`
  );
});

test("buildAnalyzeHref › valid address on testnet", () => {
  expect(buildAnalyzeHref("testnet", VALID_ADDRESS)).toBe(
    `/testnet/analyze?source=${VALID_ADDRESS}`
  );
});

test("buildAnalyzeHref › trims surrounding whitespace", () => {
  expect(buildAnalyzeHref("mainnet", `  ${VALID_ADDRESS}  `)).toBe(
    `/mainnet/analyze?source=${VALID_ADDRESS}`
  );
});

test("buildAnalyzeHref › invalid address returns null", () => {
  expect(buildAnalyzeHref("mainnet", "INVALID_ADDRESS")).toBeNull();
});

test("buildAnalyzeHref › empty string returns null", () => {
  expect(buildAnalyzeHref("mainnet", "")).toBeNull();
});
