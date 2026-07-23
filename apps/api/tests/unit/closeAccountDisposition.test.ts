import { test, expect, mock, afterEach } from "bun:test";
import { Account, Keypair, Operation, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { AssetRouteLostError } from "@/lib/utils/errors";
import type { AccountState, Trustline } from "@/types/account";
import type { AssetDisposition, PlannedStep } from "@/types/plan";
import type { StepBuildContext } from "@/lib/stellar/step-engine";

// Regression coverage for the fused CLOSE_ACCOUNT build honoring the per-asset
// disposition decided on the analyze page. The bug: a non-convertible asset the
// user chose to "return to issuer" was re-quoted via the convert branch at build
// time and raised AssetRouteLostError instead of producing an issuer payment.
//
// These tests drive the real buildStepXdrForPlan engine with the RPC and
// path-finding modules mocked, so they exercise the exact disposition read that
// the bug depended on, with no network access.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const NOSWAP = `NOSWAP:${ISSUER}`;

function trustline(over: Partial<Trustline> = {}): Trustline {
  return {
    asset: NOSWAP,
    balance: "10.0000000",
    limit: "922337203685.4775807",
    authorized: true,
    issuer: ISSUER,
    code: "NOSWAP",
    ...over,
  };
}

function accountState(): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [trustline()],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
  };
}

function closeStep(): PlannedStep {
  return {
    index: 0,
    type: "CLOSE_ACCOUNT",
    title: "Close account",
    description: "Fused close.",
    operationCount: 3,
    estimatedFeeLumens: "0.0000300",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  };
}

function ctx(dispositions: Record<string, AssetDisposition>): StepBuildContext {
  const state = accountState();
  return {
    network: "testnet",
    sourceAddress: SOURCE,
    accountState: state,
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    mediatorRequired: false,
    executionPlan: [closeStep()],
    assetDispositions: dispositions,
  };
}

// A live trustline balance read that mirrors the scan-time balance: the asset is
// funded, so the close must dispose of it (it cannot just be removed).
function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getAssetBalance: () =>
      Promise.resolve({
        latestLedger: 1,
        balanceEntry: { amount: "100000000", authorized: true, clawback: false },
      }),
  };
}

const realPaths = await import("@/lib/se-api/paths");
const realRpc = await import("@/lib/stellar/rpc");
afterEach(() => {
  mock.module("@/lib/se-api/paths", () => realPaths);
  mock.module("@/lib/stellar/rpc", () => realRpc);
});

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("CLOSE_ACCOUNT › issuer disposition returns the balance to the issuer without re-quoting", async () => {
  // No route exists for this asset. With a "convert" decision this would raise
  // AssetRouteLostError; with the user's "issuer" decision it must not even ask.
  const fetcher = mock(() => Promise.resolve(null));
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));

  const { buildStepXdrForPlan } = await import("@/lib/stellar/step-engine");
  const xdr = await buildStepXdrForPlan(closeStep(), ctx({ [NOSWAP]: "issuer" }));

  // The issuer decision must not trigger a conversion re-quote at build time.
  expect(fetcher).not.toHaveBeenCalled();

  // The fused close must contain a payment of the full balance back to the issuer,
  // the changeTrust removal, and the account merge - and no path payment.
  const ops = opsOf(xdr);
  const payment = ops.find((o) => o.type === "payment");
  expect(payment).toBeDefined();
  expect((payment as Operation.Payment).destination).toBe(ISSUER);
  expect((payment as Operation.Payment).amount).toBe("10.0000000");
  expect(ops.some((o) => o.type === "pathPaymentStrictSend")).toBe(false);
  expect(ops.some((o) => o.type === "changeTrust")).toBe(true);
  expect(ops.some((o) => o.type === "accountMerge")).toBe(true);
});

test("CLOSE_ACCOUNT › a genuinely lost route for a convert asset still surfaces AssetRouteLostError", async () => {
  // Safety invariant: the issuer fix must not mask a lost route for an asset the
  // user actually wants converted. Default disposition is "convert".
  const fetcher = mock(() => Promise.resolve(null));
  mock.module("@/lib/se-api/paths", () => ({ fetchConversionPath: fetcher }));
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));

  const { buildStepXdrForPlan } = await import("@/lib/stellar/step-engine");

  await expect(buildStepXdrForPlan(closeStep(), ctx({ [NOSWAP]: "convert" }))).rejects.toThrow(
    AssetRouteLostError
  );
});
