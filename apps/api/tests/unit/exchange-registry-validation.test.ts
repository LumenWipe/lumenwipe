import { describe, expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  REGISTRY_WARN_DAYS,
  RegistryValidationError,
  parseRegistry,
  registryDaysRemaining,
  registryExpiryWarning,
  servedRegistry,
} from "@/lib/exchange-registry";

const ADDRESS_A = Keypair.random().publicKey();
const ADDRESS_B = Keypair.random().publicKey();

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: ADDRESS_A,
    name: "Example",
    domain: "example.com",
    requiresMediator: true,
    requiresMemo: true,
    memoType: "text",
    ...overrides,
  };
}

function file(entries: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    version: "2026-10-10",
    lastVerified: "2026-10-10",
    validUntil: "2027-01-08",
    source: "https://example.com",
    entries,
    ...overrides,
  };
}

describe("parseRegistry", () => {
  test("accepts a well-formed file", () => {
    const parsed = parseRegistry(file([entry(), entry({ address: ADDRESS_B })]));
    expect(parsed.entries).toHaveLength(2);
  });

  test("rejects a duplicate address", () => {
    expect(() => parseRegistry(file([entry(), entry({ name: "Other" })]))).toThrow(
      /duplicate address/
    );
  });

  test("rejects an invalid account address", () => {
    expect(() => parseRegistry(file([entry({ address: "GNOTAKEY" })]))).toThrow(
      /invalid account address/
    );
  });

  test("rejects an unknown memo type", () => {
    expect(() => parseRegistry(file([entry({ memoType: "return" })]))).toThrow(
      /unknown memoType "return"/
    );
  });

  test("rejects requiresMemo without a memoType", () => {
    expect(() => parseRegistry(file([entry({ memoType: undefined })]))).toThrow(
      /requires a memo but has no memoType/
    );
  });

  test("rejects a malformed validUntil", () => {
    expect(() => parseRegistry(file([entry()], { validUntil: "next spring" }))).toThrow(
      /"validUntil" must be a YYYY-MM-DD date/
    );
  });

  test("rejects a missing field and a non-array entries", () => {
    expect(() => parseRegistry(file([entry({ name: "" })]))).toThrow(/non-empty "name"/);
    expect(() => parseRegistry(file([entry()], { entries: {} }))).toThrow(RegistryValidationError);
  });

  test("the shipped registry passes", () => {
    expect(servedRegistry().entries.length).toBeGreaterThan(0);
  });
});

describe("expiry warning", () => {
  const until = servedRegistry().validUntil;
  const at = (daysBefore: number): Date =>
    new Date(Date.parse(`${until}T12:00:00Z`) - daysBefore * 86_400_000);

  test("counts whole days remaining against an injected clock", () => {
    expect(registryDaysRemaining(at(45))).toBe(45);
    expect(registryDaysRemaining(at(0))).toBe(0);
    expect(registryDaysRemaining(at(-3))).toBeLessThan(0);
  });

  test("is silent with at least the warning window left", () => {
    expect(registryExpiryWarning(at(REGISTRY_WARN_DAYS))).toBeNull();
  });

  test("warns when under the window remains and names the re-verification step", () => {
    const warning = registryExpiryWarning(at(REGISTRY_WARN_DAYS - 1));
    expect(warning).toContain(until);
    expect(warning).toContain("re-verify");
  });

  test("warns that closes are refused once expired", () => {
    expect(registryExpiryWarning(at(-2))).toContain("expired");
  });
});
