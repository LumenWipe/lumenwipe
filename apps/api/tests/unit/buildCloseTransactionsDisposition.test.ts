import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as pathFinding from "@/lib/stellar/path-finding";
import type { PathResult } from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { Account, Keypair, Operation, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { AssetRouteLostError } from "@/lib/utils/errors";
import type { AccountState, Trustline } from "@lumenwipe/types";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { ledgerEntries } from "./fixtures/ledger-trustlines";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";

// Regression coverage for the close build honoring the per-asset disposition decided on the
// analyze page. The bug: a non-convertible asset the user chose to "return to issuer" was
// re-quoted via the convert branch at build time and raised AssetRouteLostError instead of
// producing an issuer payment. An unavailable price source is covered in
// price-source-unavailable.test.ts.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const NOSWAP = `NOSWAP:${ISSUER}`;

function trustline(over: Partial<Trustline> = {}): Trustline {
  return {
    asset: NOSWAP,
    balance: "10.0000000",
    limit: "922337203685.4775807",
    ...authorizationOf(true),
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
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

// A live trustline balance read that mirrors the scan-time balance: the asset is
// funded, so the close must dispose of it (it cannot just be removed).
function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: ledgerEntries(() => ({ balance: 100000000n })),
  };
}

afterEach(() => {
  mock.restore();
});

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("close build › issuer disposition returns the balance to the issuer without re-quoting", async () => {
  // No route exists for this asset. With a "convert" decision this would raise
  // AssetRouteLostError; with the user's "issuer" decision it must not even ask.
  const fetcher = mock(() => Promise.resolve<PathResult>({ kind: "none" }));
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(
    fetcher as unknown as typeof pathFinding.fetchConversionPath
  );
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);

  const result = await buildCloseTransactions(
    accountState(),
    DEST,
    { [NOSWAP]: "issuer" },
    "testnet"
  );

  // The issuer decision must not trigger a conversion re-quote at build time.
  expect(fetcher).not.toHaveBeenCalled();

  // The close must contain a payment of the full balance back to the issuer,
  // the changeTrust removal, and the account merge - and no path payment.
  const ops = opsOf(result.transactions[0]!.xdr);
  const payment = ops.find((o) => o.type === "payment");
  expect(payment).toBeDefined();
  expect((payment as Operation.Payment).destination).toBe(ISSUER);
  expect((payment as Operation.Payment).amount).toBe("10.0000000");
  expect(ops.some((o) => o.type === "pathPaymentStrictSend")).toBe(false);
  expect(ops.some((o) => o.type === "changeTrust")).toBe(true);
  expect(ops.some((o) => o.type === "accountMerge")).toBe(true);
});

test("close build › a genuinely lost route for a convert asset still surfaces AssetRouteLostError", async () => {
  // Safety invariant: the issuer fix must not mask a lost route for an asset the
  // user actually wants converted. Default disposition is "convert".
  const fetcher = mock(() => Promise.resolve<PathResult>({ kind: "none" }));
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(
    fetcher as unknown as typeof pathFinding.fetchConversionPath
  );
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);

  await expect(
    buildCloseTransactions(accountState(), DEST, { [NOSWAP]: "convert" }, "testnet")
  ).rejects.toThrow(AssetRouteLostError);
});
