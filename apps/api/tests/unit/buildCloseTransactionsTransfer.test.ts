import { test, expect, mock, afterEach } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";

// Wiring coverage for the transfer disposition (#111).
//
// fusedClose.test.ts asserts the assembler emits the right operation, but it hands the
// AssetAction in ready-made, so it would still pass if a `transfer` disposition never reached
// the builder at all - or reached it and fell through to a conversion. These drive the real
// `buildCloseTransactions` with the RPC layer mocked, so the mapping from disposition to
// operation is what is under test.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const TRANSFER_TO = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

function trustline(asset: string, balance: string): Trustline {
  const [code, issuer] = asset.split(":");
  return { asset, balance, authorized: true, issuer: issuer!, code: code!, limit: "1000" };
}

function accountState(over: Partial<AccountState> = {}): AccountState {
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
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    ...over,
  };
}

/** Reports the trustline balance unchanged, so the live re-read is not what these test. */
function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
    getAssetBalance: () => Promise.reject(new Error("not stubbed")),
  };
}

const realRpc = await import("@/lib/stellar/rpc");
afterEach(() => {
  mock.module("@/lib/stellar/rpc", () => realRpc);
});

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("a transfer disposition reaches the builder as a payment to the chosen account", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ trustlines: [trustline(USDC, "100")] });
  const result = await buildCloseTransactions(
    state,
    DEST,
    { [USDC]: "transfer" },
    "testnet",
    null,
    {},
    { [USDC]: TRANSFER_TO }
  );

  const ops = opsOf(result.transactions[0]!.xdr);
  const payment = ops.find((o) => o.type === "payment") as { destination: string; amount: string };
  expect(payment).toBeDefined();
  expect(payment.destination).toBe(TRANSFER_TO);
  expect(Number(payment.amount)).toBe(100);

  // Not the issuer, and not a swap: those are the two ways the old two-case branches would
  // have resolved this disposition, both destroying the balance.
  expect(payment.destination).not.toBe(ISSUER);
  expect(ops.some((o) => o.type === "pathPaymentStrictSend")).toBe(false);
});

test("the payment precedes the changeTrust that removes the same trustline", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ trustlines: [trustline(USDC, "100")] });
  const result = await buildCloseTransactions(
    state,
    DEST,
    { [USDC]: "transfer" },
    "testnet",
    null,
    {},
    { [USDC]: TRANSFER_TO }
  );

  const ops = opsOf(result.transactions[0]!.xdr);
  const paymentAt = ops.findIndex((o) => o.type === "payment");
  // The removal specifically: a limit of "0" on the asset being transferred. Matching any
  // changeTrust would also match the one an add-trustline-for-claim round emits earlier.
  const removalAt = ops.findIndex(
    (o) => o.type === "changeTrust" && Number((o as { limit?: string }).limit ?? "0") === 0
  );
  expect(paymentAt).toBeGreaterThanOrEqual(0);
  expect(removalAt).toBeGreaterThanOrEqual(0);
  expect(paymentAt).toBeLessThan(removalAt);
});

test("a transfer disposition with no destination refuses instead of converting", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const { MissingTransferDestinationError } = await import("@/lib/close-api/decisions");

  const state = accountState({ trustlines: [trustline(USDC, "100")] });

  // The failure mode being pinned: falling through to the conversion path would swap away the
  // exact balance the caller asked to keep, and report success.
  await expect(
    buildCloseTransactions(state, DEST, { [USDC]: "transfer" }, "testnet", null, {}, {})
  ).rejects.toBeInstanceOf(MissingTransferDestinationError);
});

test("transfer composes with issuer on another asset in the same close", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const otherIssuer = Keypair.random().publicKey();
  const eurc = `EURC:${otherIssuer}`;
  const state = accountState({
    trustlines: [trustline(USDC, "100"), trustline(eurc, "50")],
    numSubEntries: 2,
  });

  const result = await buildCloseTransactions(
    state,
    DEST,
    { [USDC]: "transfer", [eurc]: "issuer" },
    "testnet",
    null,
    {},
    { [USDC]: TRANSFER_TO }
  );

  const ops = opsOf(result.transactions[0]!.xdr);
  const payments = ops.filter((o) => o.type === "payment") as { destination: string }[];
  expect(payments).toHaveLength(2);
  // One to the user's account, one to the issuer - each asset resolved as its own answer said.
  expect(payments.map((p) => p.destination).sort()).toEqual([TRANSFER_TO, otherIssuer].sort());
});

test("the summary names the destination, not just a count", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ trustlines: [trustline(USDC, "100")] });
  const result = await buildCloseTransactions(
    state,
    DEST,
    { [USDC]: "transfer" },
    "testnet",
    null,
    {},
    { [USDC]: TRANSFER_TO }
  );

  // This string is what the caller reads before an irreversible close. "transfer 1 asset to
  // another account" gives them no address to check.
  const summary = result.transactions[0]!.intent.summary;
  expect(summary).toContain(TRANSFER_TO);
  expect(summary).toContain("USDC");
});
