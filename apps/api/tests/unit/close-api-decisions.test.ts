import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { deriveDecisionPoints, resolveDispositions } from "@/lib/close-api/decisions";
import type { AccountState, Trustline } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1234567890",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    ...overrides,
  };
}

function makeTrustline(code: string, balance: string): Trustline {
  return { asset: `${code}:${ISSUER}`, balance, authorized: true, issuer: ISSUER, code };
}

test("a trustline with a balance produces a convertible asset_disposition decision point", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "10")] });
  const points = deriveDecisionPoints(account, { [`USDC:${ISSUER}`]: true });

  expect(points).toHaveLength(1);
  expect(points[0].type).toBe("asset_disposition");
  expect(points[0].id).toBe(`asset:USDC-${ISSUER}`);
  expect(points[0].options.map((o) => o.id)).toEqual(["convert_to_xlm", "return_to_issuer"]);
  expect(points[0].default).toBe("convert_to_xlm");
});

test("a non-convertible asset offers only return_to_issuer", () => {
  const account = makeAccount({ trustlines: [makeTrustline("FOO", "5")] });
  const points = deriveDecisionPoints(account, { [`FOO:${ISSUER}`]: false });

  expect(points[0].options.map((o) => o.id)).toEqual(["return_to_issuer"]);
  expect(points[0].default).toBe("return_to_issuer");
  expect((points[0].subject as { convertible: boolean }).convertible).toBe(false);
});

test("zero-balance trustlines produce no decision point", () => {
  const account = makeAccount({ trustlines: [makeTrustline("USDC", "0")] });
  expect(deriveDecisionPoints(account, {})).toHaveLength(0);
});

test("resolveDispositions maps answers to the assetDispositions record", () => {
  const dispositions = resolveDispositions(
    [{ id: `asset:USDC-${ISSUER}`, choice: "convert_to_xlm" }],
    [{ id: `asset:USDC-${ISSUER}`, asset: `USDC:${ISSUER}` }]
  );
  expect(dispositions).toEqual({ [`USDC:${ISSUER}`]: "convert" });
});

test("resolveDispositions maps return_to_issuer to issuer", () => {
  const dispositions = resolveDispositions(
    [{ id: `asset:FOO-${ISSUER}`, choice: "return_to_issuer" }],
    [{ id: `asset:FOO-${ISSUER}`, asset: `FOO:${ISSUER}` }]
  );
  expect(dispositions).toEqual({ [`FOO:${ISSUER}`]: "issuer" });
});
