import { test, expect } from "bun:test";
import {
  entriesForNetwork,
  entriesForProtocol,
  isRegistryFresh,
  lookupByWasmHash,
  servedContractRegistry,
} from "@/lib/contract-registry";

test("serves the registry with its freshness metadata", () => {
  const registry = servedContractRegistry();
  expect(registry.entries.length).toBeGreaterThan(0);
  expect(typeof registry.lastVerified).toBe("string");
  expect(typeof registry.validUntil).toBe("string");
});

test("only testnet entries exist today - mainnet detection stays on OctoPos", () => {
  const registry = servedContractRegistry();
  expect(registry.entries.every((e) => e.network === "testnet")).toBe(true);
});

test("filters entries by network", () => {
  expect(entriesForNetwork("testnet").length).toBeGreaterThan(0);
  expect(entriesForNetwork("mainnet")).toEqual([]);
});

test("filters entries by network and protocol", () => {
  const blend = entriesForProtocol("testnet", "blend");
  expect(blend.length).toBeGreaterThan(0);
  expect(blend.every((e) => e.protocol === "blend")).toBe(true);
});

test("looks up an entry by its recorded wasmHash", () => {
  const [firstBlend] = entriesForProtocol("testnet", "blend");
  expect(firstBlend?.wasmHash).not.toBeNull();
  const found = lookupByWasmHash(firstBlend!.wasmHash!);
  expect(found?.address).toBe(firstBlend!.address);
});

test("returns null for an unknown wasmHash", () => {
  expect(lookupByWasmHash("0".repeat(64))).toBeNull();
});

test("carries a null wasmHash for the documented-but-unresolvable FxDAO entry rather than a guess", () => {
  const fxdao = entriesForProtocol("testnet", "fxdao");
  expect(fxdao.some((e) => e.wasmHash === null && e.verifiedLive === false)).toBe(true);
});

test("today's date is within the registry's verification window", () => {
  expect(isRegistryFresh(new Date())).toBe(true);
});

test("is fail-closed past validUntil", () => {
  const registry = servedContractRegistry();
  const pastValidUntil = new Date(`${registry.validUntil}T23:59:59Z`);
  pastValidUntil.setDate(pastValidUntil.getDate() + 1);
  expect(isRegistryFresh(pastValidUntil)).toBe(false);
});
