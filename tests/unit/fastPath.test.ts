import { test, expect, mock, afterEach } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@/types/account";
import type { ConversionPath } from "@/types/plan";

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

// Bun's mock.module is module-global, so restore the real implementation after
// each test to keep the mock from leaking into other test files in the suite.
const realPaths = await import("@/lib/se-api/paths");
afterEach(() => {
  mock.module("@/lib/se-api/paths", () => realPaths);
});

test("assessConversionsClean › no trustlines → true without calling the network", async () => {
  const fetcher = mock(() => Promise.resolve<ConversionPath | null>(null));
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  const { assessConversionsClean } = await import("@/lib/stellar/fast-path");

  const result = await assessConversionsClean(makeAccount({ trustlines: [] }), "testnet");

  expect(result).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

test("assessConversionsClean › only zero-balance trustlines → true without calling the network", async () => {
  const fetcher = mock(() => Promise.resolve<ConversionPath | null>(null));
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  const { assessConversionsClean } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({
    trustlines: [makeTrustline({ balance: "0" }), makeTrustline({ balance: "0.0000000" })],
  });
  const result = await assessConversionsClean(account, "testnet");

  expect(result).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

test("assessConversionsClean › every asset with balance has a path → true", async () => {
  const fetcher = mock((fromAsset: string) =>
    Promise.resolve<ConversionPath | null>(makePath(fromAsset))
  );
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  const { assessConversionsClean } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({
    trustlines: [
      makeTrustline({ asset: `USDC:${ISSUER}`, code: "USDC", balance: "100" }),
      makeTrustline({ asset: `EURC:${ISSUER}`, code: "EURC", balance: "50" }),
    ],
  });
  const result = await assessConversionsClean(account, "testnet");

  expect(result).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("assessConversionsClean › at least one asset returns null → false", async () => {
  const fetcher = mock((fromAsset: string) =>
    Promise.resolve<ConversionPath | null>(
      fromAsset.startsWith("EURC") ? null : makePath(fromAsset)
    )
  );
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  const { assessConversionsClean } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({
    trustlines: [
      makeTrustline({ asset: `USDC:${ISSUER}`, code: "USDC", balance: "100" }),
      makeTrustline({ asset: `EURC:${ISSUER}`, code: "EURC", balance: "50" }),
    ],
  });
  const result = await assessConversionsClean(account, "testnet");

  expect(result).toBe(false);
});

test("assessConversionsClean › a thrown fetcher counts as no path → false", async () => {
  const fetcher = mock(() => Promise.reject<ConversionPath | null>(new Error("network down")));
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  const { assessConversionsClean } = await import("@/lib/stellar/fast-path");

  const account = makeAccount({ trustlines: [makeTrustline({ balance: "100" })] });
  const result = await assessConversionsClean(account, "testnet");

  expect(result).toBe(false);
});
