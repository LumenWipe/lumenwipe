import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as pathFinding from "@/lib/stellar/path-finding";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState, Trustline, ConversionPath } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function makeAccount(over: Partial<AccountState> = {}): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "5",
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
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
    ...over,
  };
}

function makeTrustline(over: Partial<Trustline> = {}): Trustline {
  return {
    asset: `USDC:${ISSUER}`,
    balance: "100",
    authorized: true,
    issuer: ISSUER,
    code: "USDC",
    ...over,
  };
}

function makePath(fromAsset: string): ConversionPath {
  return {
    fromAsset,
    toAsset: "native",
    path: [],
    estimatedReceive: "9",
    destMin: "8.9",
  };
}

// Network calls are patched with spyOn on the real module objects (never mock.module, which
// replaces a module for the whole `bun test` process and leaked into other files in CI).
afterEach(() => {
  mock.restore();
});

test("assessConversions › no balance-bearing trustlines → [] without calling the network", async () => {
  const fetcher = mock(() => Promise.resolve<ConversionPath | null>(null));
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(
    fetcher as unknown as typeof pathFinding.fetchConversionPath
  );
  const { assessConversions } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({
    trustlines: [makeTrustline({ balance: "0" }), makeTrustline({ balance: "0.0000000" })],
  });
  const result = await assessConversions(account, "testnet");

  expect(result).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

test("assessConversions › every asset with balance has a path → all convertible", async () => {
  const fetcher = mock((fromAsset: string) =>
    Promise.resolve<ConversionPath | null>(makePath(fromAsset))
  );
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(
    fetcher as unknown as typeof pathFinding.fetchConversionPath
  );
  const { assessConversions } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({
    trustlines: [
      makeTrustline({ asset: `USDC:${ISSUER}`, code: "USDC", balance: "100" }),
      makeTrustline({ asset: `EURC:${ISSUER}`, code: "EURC", balance: "50" }),
    ],
  });
  const result = await assessConversions(account, "testnet");

  expect(result).toHaveLength(2);
  expect(result.every((a) => a.convertible)).toBe(true);
  expect(result).toEqual([
    { asset: `USDC:${ISSUER}`, code: "USDC", balance: "100", convertible: true },
    { asset: `EURC:${ISSUER}`, code: "EURC", balance: "50", convertible: true },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("assessConversions › one asset returns null → only that entry is not convertible", async () => {
  const fetcher = mock((fromAsset: string) =>
    Promise.resolve<ConversionPath | null>(
      fromAsset.startsWith("EURC") ? null : makePath(fromAsset)
    )
  );
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(
    fetcher as unknown as typeof pathFinding.fetchConversionPath
  );
  const { assessConversions } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({
    trustlines: [
      makeTrustline({ asset: `USDC:${ISSUER}`, code: "USDC", balance: "100" }),
      makeTrustline({ asset: `EURC:${ISSUER}`, code: "EURC", balance: "50" }),
    ],
  });
  const result = await assessConversions(account, "testnet");

  expect(result).toEqual([
    { asset: `USDC:${ISSUER}`, code: "USDC", balance: "100", convertible: true },
    { asset: `EURC:${ISSUER}`, code: "EURC", balance: "50", convertible: false },
  ]);
});

test("assessConversions › a thrown fetcher counts as not convertible", async () => {
  const fetcher = mock(() => Promise.reject<ConversionPath | null>(new Error("network down")));
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(
    fetcher as unknown as typeof pathFinding.fetchConversionPath
  );
  const { assessConversions } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({ trustlines: [makeTrustline({ balance: "100" })] });
  const result = await assessConversions(account, "testnet");

  expect(result).toEqual([
    { asset: `USDC:${ISSUER}`, code: "USDC", balance: "100", convertible: false },
  ]);
});
