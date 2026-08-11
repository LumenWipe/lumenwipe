import { test, expect } from "bun:test";
import { LOBSTR_ID } from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { ALLOWED_DEFAULT_MODULE_IDS, vettedDefaultModules } from "@/lib/wallet-kit/modules";

test("vettedDefaultModules › never includes LOBSTR's own module", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  expect(ids).not.toContain(LOBSTR_ID);
});

test("vettedDefaultModules › includes exactly the vetted whitelist, nothing else", () => {
  const ids = vettedDefaultModules()
    .map((m) => m.productId)
    .sort();
  expect(ids).toEqual([...ALLOWED_DEFAULT_MODULE_IDS].sort());
});

test("vettedDefaultModules › includes Freighter", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  expect(ids).toContain(FREIGHTER_ID);
});
