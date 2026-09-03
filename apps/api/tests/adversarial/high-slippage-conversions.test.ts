/**
 * Adversarial coverage: high-slippage conversions (docs/architecture.md §17 and §8, issue #167).
 *
 * The only one of the three DeFi-adjacent hostile states named in #167 with real, testable
 * production code today - classic asset-to-XLM conversion, unlike the Blend/FxDAO exit adapters
 * the other two depend on (see undercollateralized-vaults.test.ts /
 * queued-backstop-withdrawals.test.ts for that stub-harness boundary).
 *
 * Existing coverage (asset-conversion.test.ts, closeAccountDisposition.test.ts,
 * stepEngine.test.ts) exercises op-shape correctness and total route loss (a mocked
 * `fetchConversionPath` returning null → `AssetRouteLostError`). Nothing exercised
 * `applySlippage`'s own rounding math directly, or the genuinely adversarial case of a route
 * that's still *present* at build time but worse than what analysis showed - as opposed to gone
 * entirely.
 */
import { test, expect, spyOn, afterEach, mock } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks, Operation } from "@stellar/stellar-sdk";
import { applySlippage } from "@/lib/stellar/path-finding";
import * as pathFindingModule from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import type { AccountState, ConversionPath } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

afterEach(() => {
  mock.restore();
});

// ─── applySlippage's own rounding math ───────────────────────────────────────────────────────

test("applySlippage cuts exactly SLIPPAGE_BPS (0.5%) from the quoted amount", () => {
  // 100 XLM, 0.5% slippage -> destMin of 99.5 XLM exactly (stroopsToXlm trims trailing zeros).
  expect(applySlippage("100.0000000")).toBe("99.5");
});

test("applySlippage floors at the stroop boundary rather than rounding up", () => {
  // 1 stroop (0.0000001 XLM) * 0.995 = 0.0000000995 stroops, which floors to 0 stroops -
  // below the "destMin rounds to 0" branch's own threshold, this is the raw floor behavior
  // BigInt division applies before that branch is even reached.
  expect(applySlippage("0.0000001")).toBe("0");
});

test("applySlippage returns exactly '0' when the slippage-adjusted amount is unusable, never a negative or fractional stroop", () => {
  const result = applySlippage("0.0000003");
  // 3 stroops * 9950 / 10000 = 2.985, BigInt-floors to 2 stroops = "0.0000002" - never "0"
  // itself unless the true floor is zero. Pinned down precisely, not just "falsy".
  expect(result).toBe("0.0000002");
  expect(applySlippage("0.0000000")).toBe("0");
});

// ─── build-time re-quote embeds the fresh destMin, not a stale one ──────────────────────────

function accountState(balance: string): AccountState {
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
    trustlines: [
      { asset: USDC, balance, authorized: true, issuer: ISSUER, code: "USDC", limit: "1000" },
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
    getAssetBalance: () => Promise.resolve("100.0000000"),
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>;
}

function destMinOf(xdr: string): string {
  const op = TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations.find(
    (o) => o.type === "pathPaymentStrictSend"
  ) as Operation.PathPaymentStrictSend;
  return op.destMin;
}

test("a build called twice embeds each call's own fresh quote, never a cached or stale one", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(rpcServerStub());

  const worsePath: ConversionPath = {
    fromAsset: USDC,
    toAsset: "native",
    path: [],
    estimatedReceive: "100.0000000",
    destMin: "80.0000000", // a materially worse quote than a first build might have seen
  };
  const betterPath: ConversionPath = {
    fromAsset: USDC,
    toAsset: "native",
    path: [],
    estimatedReceive: "100.0000000",
    destMin: "99.5000000",
  };

  spyOn(pathFindingModule, "fetchConversionPath").mockResolvedValueOnce(betterPath);
  const firstResult = await buildCloseTransactions(accountState("100"), DEST, {}, "testnet");
  expect(destMinOf(firstResult.transactions[0]!.xdr)).toBe("99.5000000");

  // A second build - a real caller re-requesting after the route degraded between rounds -
  // gets the worse quote embedded, not the first call's now-stale better one. No memoization
  // anywhere in build-transactions.ts's own trustline-conversion loop would let this differ.
  spyOn(pathFindingModule, "fetchConversionPath").mockResolvedValueOnce(worsePath);
  const secondResult = await buildCloseTransactions(accountState("100"), DEST, {}, "testnet");
  expect(destMinOf(secondResult.transactions[0]!.xdr)).toBe("80.0000000");
});
