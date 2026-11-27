import { describe, expect, test } from "bun:test";
import registryJson from "@/config/exchange-registry.json";
import signatureJson from "@/config/exchange-registry.sig.json";
import { RegistryController } from "@/config-api/registry.controller";
import {
  RegistryValidationError,
  parseRegistry,
  parseSignature,
  servedRegistry,
} from "@/lib/exchange-registry";

const VALID = {
  format: 1 as const,
  sequence: 3,
  issuedAt: "2026-11-27",
  signature: `${"A".repeat(86)}==`,
};

describe("the served exchange registry's signature", () => {
  test("is the committed envelope, unchanged, beside the registry fields", () => {
    const body = new RegistryController().registry();
    expect(body.signature).toEqual(signatureJson as unknown as typeof VALID);
    expect(body.entries).toEqual(parseRegistry(registryJson).entries);
  });

  test("is not attached to a registry that is not the shipped one", () => {
    const other = { ...parseRegistry(registryJson), version: "other" };
    expect(servedRegistry(other).signature).toBeUndefined();
  });

  test("the committed file is a version 1 envelope", () => {
    expect(parseSignature(signatureJson)).toEqual(signatureJson as unknown as typeof VALID);
  });
});

describe("parseSignature", () => {
  test("takes a version 1 envelope", () => {
    expect(parseSignature(VALID)).toEqual(VALID);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["an extra field", { ...VALID, keyId: "x" }],
    ["format 2", { ...VALID, format: 2 }],
    ["sequence 0", { ...VALID, sequence: 0 }],
    ["a fractional sequence", { ...VALID, sequence: 1.5 }],
    ["a bad date", { ...VALID, issuedAt: "27-11-2026" }],
    ["a short signature", { ...VALID, signature: "AAAA" }],
    ["a url-safe signature", { ...VALID, signature: `${"-".repeat(86)}==` }],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseSignature(raw)).toThrow(RegistryValidationError);
  });
});
