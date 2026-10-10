import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as rpcModule from "@/lib/stellar/rpc";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import {
  AUTHORIZED,
  AUTHORIZED_TO_MAINTAIN_LIABILITIES,
  ledgerEntries,
  mirrorSnapshot,
  type LineSpec,
} from "./fixtures/ledger-trustlines";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { DestinationReadError } from "@/lib/close-api/merge-preflight";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

// Wiring coverage for the transfer disposition (#111).
//
// closeOperations.test.ts asserts the assembler emits the right operation, but it hands the
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

function makeState(over: Partial<AccountState> = {}): AccountState {
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
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ...over,
  };
}

let snapshot: Trustline[] = [];
function accountState(...args: Parameters<typeof makeState>): AccountState {
  const state = makeState(...args);
  snapshot = state.trustlines;
  return state;
}

/** Reports the trustline balance unchanged, so the live re-read is not what these test. */
function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: mirrorSnapshot(SOURCE, () => snapshot, {
      [`${TRANSFER_TO}|${USDC}`]: { balance: 0n },
    }),
  };
}

afterEach(() => {
  mock.restore();
});

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("a transfer disposition reaches the builder as a payment to the chosen account", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
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
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
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
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
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
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
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
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
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

const STROOP = 1n;
const XLM = 10_000_000n;

/** The source holds `live` of USDC on the ledger; the destination's line is `destination`. */
function useLedger(live: bigint | null, destination: LineSpec | null): void {
  const lines: Record<string, LineSpec> = {};
  if (live !== null) lines[`${SOURCE}|${USDC}`] = { balance: live };
  if (destination) lines[`${TRANSFER_TO}|${USDC}`] = destination;
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    ...rpcServerStub(),
    getLedgerEntries: ledgerEntries(lines),
  })) as unknown as typeof rpcModule.getRpcServer);
}

async function buildTransfer(snapshotBalance = "100") {
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  return buildCloseTransactions(
    accountState({ trustlines: [trustline(USDC, snapshotBalance)] }),
    DEST,
    { [USDC]: "transfer" },
    "testnet",
    null,
    {},
    { [USDC]: TRANSFER_TO }
  );
}

test("a failed live balance read is refused, never replaced by the snapshot balance", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    ...rpcServerStub(),
    getLedgerEntries: () => Promise.reject(new Error("rpc down")),
  })) as unknown as typeof rpcModule.getRpcServer);
  await expect(buildTransfer()).rejects.toBeInstanceOf(LiveReadError);
});

test("a trustline the ledger no longer holds is skipped, not paid from the snapshot", async () => {
  useLedger(null, { balance: 0n });
  const result = await buildTransfer();
  expect(opsOf(result.transactions[0]!.xdr).some((o) => o.type === "payment")).toBe(false);
});

test("a balance that changed between plan and build is paid from the live value", async () => {
  useLedger(130_5000000n, { balance: 0n });
  const result = await buildTransfer("100");
  const payment = opsOf(result.transactions[0]!.xdr).find((o) => o.type === "payment") as {
    amount: string;
  };
  expect(payment.amount).toBe("130.5000000");
});

test("buying liabilities reduce destination headroom and an exact fit still passes", async () => {
  const limit = 1000n * XLM;
  const fit = { balance: 800n * XLM, buying: 100n * XLM, limit };
  useLedger(100n * XLM, fit);
  const ok = await buildTransfer("100");
  expect(opsOf(ok.transactions[0]!.xdr).some((o) => o.type === "payment")).toBe(true);

  mock.restore();
  useLedger(100n * XLM + STROOP, fit);
  await expect(buildTransfer("100")).rejects.toMatchObject({
    code: "transfer_destination_unusable",
    status: 422,
  });
});

test("headroom is exact beyond double precision", async () => {
  const limit = 922337203685_4775807n;
  useLedger(2n, { balance: limit - 1n, buying: 0n, limit });
  await expect(buildTransfer("100")).rejects.toMatchObject({
    code: "transfer_destination_unusable",
  });
  mock.restore();
  useLedger(2n, { balance: limit - 2n, buying: 0n, limit });
  const result = await buildTransfer("100");
  expect(result.transactions).toHaveLength(1);
});

test("a destination line authorized only to maintain liabilities cannot receive", async () => {
  useLedger(100n * XLM, { balance: 0n, flags: AUTHORIZED_TO_MAINTAIN_LIABILITIES });
  await expect(buildTransfer("100")).rejects.toMatchObject({
    code: "transfer_destination_unusable",
  });
  mock.restore();
  useLedger(100n * XLM, { balance: 0n, flags: AUTHORIZED });
  expect((await buildTransfer("100")).transactions).toHaveLength(1);
});

test("a destination that lost its trustline since the plan is refused", async () => {
  useLedger(100n * XLM, null);
  await expect(buildTransfer("100")).rejects.toMatchObject({
    code: "transfer_destination_unusable",
  });
});

test("a failed destination read is a retryable error, not a missing trustline", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    ...rpcServerStub(),
    getLedgerEntries: (...keys: Parameters<ReturnType<typeof ledgerEntries>>) => {
      const owner = keys[0]!.trustLine().accountId().ed25519();
      return owner.equals(Keypair.fromPublicKey(SOURCE).rawPublicKey())
        ? ledgerEntries({ [`${SOURCE}|${USDC}`]: { balance: 100n * XLM } })(...keys)
        : Promise.reject(new Error("rpc down"));
    },
  })) as unknown as typeof rpcModule.getRpcServer);
  await expect(buildTransfer("100")).rejects.toBeInstanceOf(DestinationReadError);
});
