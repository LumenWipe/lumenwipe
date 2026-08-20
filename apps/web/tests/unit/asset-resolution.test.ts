import { test, expect } from "bun:test";
import { assetsResolved } from "@/lib/plan/asset-resolution";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";

// Real keypairs: isValidGAddress checks the StrKey checksum, so a fabricated 56-character
// string fails validation and would make the transfer cases pass for the wrong reason.
const ISSUER = "GBGBPPN2ACLYY4W2FGHMDTAD6CVFXX3STWYFQV6ZX7TFZYQYHAIUZMAT";
const DEST = "GBWLBY2XERGCNM5UWRIF5ZG6LM7Q7B44MHUR54BT3XVHAD5IB4HLN3XG";

function asset(code: string, convertible: boolean): AssetConvertibility {
  return { asset: `${code}:${ISSUER}`, code, balance: "10", convertible };
}

test("an account with no balance-bearing assets is resolved", () => {
  expect(
    assetsResolved({
      conversions: [],
      balanceBearingCount: 0,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(true);
});

test("withheld asset cards are NOT resolved, however empty the list looks", () => {
  // The bug this exists for. `[].every(...)` is true, so an empty list read as "all resolved"
  // - and the account that surfaced it held 38 balance-bearing assets whose cards were never
  // rendered, because 23 resolvable claimable-balance blockers had emptied the list. The user
  // reached "Begin execution" and was refused for decisions the UI had never shown them.
  expect(
    assetsResolved({
      conversions: [],
      balanceBearingCount: 38,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(false);
});

test("a convertible asset is resolved by default", () => {
  expect(
    assetsResolved({
      conversions: [asset("USDC", true)],
      balanceBearingCount: 1,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(true);
});

test("a non-convertible asset blocks until answered", () => {
  const base = {
    conversions: [asset("FOO", false)],
    balanceBearingCount: 1,
    transferDestinations: {},
  };
  expect(assetsResolved({ ...base, dispositions: {} })).toBe(false);
  expect(assetsResolved({ ...base, dispositions: { [`FOO:${ISSUER}`]: "issuer" } })).toBe(true);
});

test("a transfer needs a valid address, not just the choice", () => {
  const conversions = [asset("FOO", false)];
  const dispositions = { [`FOO:${ISSUER}`]: "transfer" as const };
  const base = { conversions, balanceBearingCount: 1, dispositions };

  expect(assetsResolved({ ...base, transferDestinations: {} })).toBe(false);
  expect(assetsResolved({ ...base, transferDestinations: { [`FOO:${ISSUER}`]: "nope" } })).toBe(
    false
  );
  expect(assetsResolved({ ...base, transferDestinations: { [`FOO:${ISSUER}`]: DEST } })).toBe(true);
});

test("a convertible asset switched to transfer also needs the address", () => {
  // The swap default must not keep vouching for an asset the user moved off it.
  const conversions = [asset("USDC", true)];
  const dispositions = { [`USDC:${ISSUER}`]: "transfer" as const };
  expect(
    assetsResolved({ conversions, balanceBearingCount: 1, dispositions, transferDestinations: {} })
  ).toBe(false);
});

test("one unresolved asset among many blocks the whole set", () => {
  expect(
    assetsResolved({
      conversions: [asset("USDC", true), asset("FOO", false)],
      balanceBearingCount: 2,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(false);
});
