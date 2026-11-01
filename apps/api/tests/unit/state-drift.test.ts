import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Asset, Keypair, LiquidityPoolId, rpc, type xdr } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { requestContextMiddleware } from "@/common/request-context";
import * as rpcModule from "@/lib/stellar/rpc";
import { pinnedRpcProvider } from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { mapDomainError, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { confirmLedgerState, findStateDrift } from "@/lib/close-api/state-drift";
import { RPC_FALLBACKS, RPC_URLS } from "@/config/networks";
import { readLiveLedger, RPC_LEDGER_KEY_LIMIT } from "@/lib/stellar/live-ledger";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { AccountStateChangedError } from "@/lib/utils/errors";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import {
  accountLedgerEntry,
  dataLedgerEntry,
  ledgerServer,
  offerLedgerEntry,
  trustlineLedgerEntry,
  type AccountEntrySpec,
  type LedgerEntryFixture,
} from "./fixtures/live-ledger";
import { authorizationOf } from "./fixtures/trustline";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const COSIGNER = Keypair.random().publicKey();
const SEQUENCE = "9007199254740993";
const USDC = new Asset("USDC", ISSUER);
const POOL_ID = "ab".repeat(32);
const DATA_VALUE = Buffer.from("hello").toString("base64");

function state(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: SEQUENCE,
    nativeBalanceLumens: "50.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 0, high: 0 },
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
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ...over,
  };
}

/** An account holding one of every entry kind, and the ledger that agrees with it. */
function fullState(): AccountState {
  return state({
    numSubEntries: 6,
    signers: [
      { key: SOURCE, weight: 1, type: "ed25519_public_key" },
      { key: COSIGNER, weight: 2, type: "ed25519_public_key" },
    ],
    thresholds: { low: 1, med: 2, high: 3 },
    trustlines: [
      {
        asset: `USDC:${ISSUER}`,
        balance: "12.5000000",
        limit: "1000.0000000",
        ...authorizationOf(true),
        issuer: ISSUER,
        code: "USDC",
      },
    ],
    poolShares: [{ poolId: POOL_ID }],
    openOffers: [
      { id: "77", selling: `USDC:${ISSUER}`, buying: "native", amount: "2.0000000", price: "1" },
    ],
    dataEntries: [{ key: "note", value: DATA_VALUE }],
  });
}

const FULL_ACCOUNT: AccountEntrySpec = {
  sequence: SEQUENCE,
  numSubEntries: 6,
  thresholds: [1, 1, 2, 3],
  signers: [{ key: COSIGNER, weight: 2 }],
};

function fullLedger(
  over: {
    account?: Partial<AccountEntrySpec>;
    usdcBalance?: bigint;
    usdcFlags?: number;
    offerAmount?: bigint | null;
    data?: string | null;
    pool?: boolean;
  } = {}
): LedgerEntryFixture[] {
  return [
    accountLedgerEntry(SOURCE, { ...FULL_ACCOUNT, ...over.account }),
    trustlineLedgerEntry(
      SOURCE,
      USDC,
      over.usdcBalance ?? 125_000_000n,
      10_000_000_000n,
      over.usdcFlags ?? 1
    ),
    ...(over.pool === false
      ? []
      : [trustlineLedgerEntry(SOURCE, new LiquidityPoolId(POOL_ID), 5n)]),
    ...(over.offerAmount === null
      ? []
      : [offerLedgerEntry(SOURCE, 77n, USDC, Asset.native(), over.offerAmount ?? 20_000_000n)]),
    ...(over.data === null ? [] : [dataLedgerEntry(SOURCE, "note", over.data ?? DATA_VALUE)]),
  ];
}

async function driftAgainst(entries: LedgerEntryFixture[]): Promise<string | null> {
  return findStateDrift(
    fullState(),
    await readLiveLedger(
      ledgerServer(() => entries),
      fullState()
    )
  );
}

const agreeing: AccountEntrySpec = { sequence: SEQUENCE, numSubEntries: 0 };

function useLedger(spec: AccountEntrySpec | null) {
  const server = ledgerServer(() => (spec ? [accountLedgerEntry(SOURCE, spec)] : []));
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    ...server,
    getLatestLedger: async () => ({ sequence: 1000 }),
  })) as unknown as typeof rpcModule.getRpcServer);
  return server;
}

const build = () => buildCloseTransactions(state(), DEST, {}, "testnet");

afterEach(() => mock.restore());

describe("findStateDrift", () => {
  test("a ledger that holds every enumerated entry unchanged is no drift", async () => {
    expect(await driftAgainst(fullLedger())).toBeNull();
  });

  test("a sequence one above the enumerated one is drift, even beyond 2^53", async () => {
    expect(await driftAgainst(fullLedger({ account: { sequence: "9007199254740994" } }))).toContain(
      "sequence"
    );
  });

  test("a different sub-entry count is drift", async () => {
    expect(await driftAgainst(fullLedger({ account: { numSubEntries: 7 } }))).toContain(
      "sub-entries"
    );
  });

  test("an account the ledger no longer holds is drift", async () => {
    expect(await driftAgainst(fullLedger().slice(1))).toBe("account no longer exists");
  });

  test("an XLM balance that changed is drift", async () => {
    expect(await driftAgainst(fullLedger({ account: { balance: 500_000_001n } }))).toBe(
      "XLM balance changed"
    );
  });

  test("a trustline whose live balance differs is drift", async () => {
    expect(await driftAgainst(fullLedger({ usdcBalance: 125_000_001n }))).toBe(
      `USDC:${ISSUER} balance changed`
    );
  });

  test("a trustline whose authorization changed is drift", async () => {
    expect(await driftAgainst(fullLedger({ usdcFlags: 2 }))).toBe(
      `USDC:${ISSUER} authorization changed`
    );
  });

  test("a removed offer is drift", async () => {
    expect(await driftAgainst(fullLedger({ offerAmount: null }))).toBe("offer 77 no longer exists");
  });

  test("an offer whose amount changed is drift", async () => {
    expect(await driftAgainst(fullLedger({ offerAmount: 10_000_000n }))).toBe("offer 77 changed");
  });

  test("a changed data entry is drift", async () => {
    expect(await driftAgainst(fullLedger({ data: Buffer.from("other").toString("base64") }))).toBe(
      "data entry note changed"
    );
  });

  test("a removed pool share trustline is drift", async () => {
    expect(await driftAgainst(fullLedger({ pool: false }))).toBe(
      `pool share ${POOL_ID} no longer exists`
    );
  });

  test("a changed signer set is drift", async () => {
    expect(
      await driftAgainst(fullLedger({ account: { signers: [{ key: COSIGNER, weight: 1 }] } }))
    ).toBe("signers changed");
  });

  test("a changed master key weight is drift", async () => {
    expect(await driftAgainst(fullLedger({ account: { thresholds: [0, 1, 2, 3] } }))).toBe(
      "signers changed"
    );
  });

  test("changed thresholds are drift", async () => {
    expect(await driftAgainst(fullLedger({ account: { thresholds: [1, 1, 2, 2] } }))).toBe(
      "thresholds changed"
    );
  });
});

describe("readLiveLedger", () => {
  test("reads every entry of a plan within the key limit in one call", async () => {
    const server = ledgerServer(() => fullLedger());
    await readLiveLedger(server, fullState());
    expect(server.calls).toEqual([5]);
  });

  test("chunks the keys beyond the limit", async () => {
    expect(RPC_LEDGER_KEY_LIMIT).toBe(200);
    const offers = Array.from({ length: RPC_LEDGER_KEY_LIMIT }, (_, i) => ({
      id: String(i + 1),
      selling: `USDC:${ISSUER}`,
      buying: "native",
      amount: "1.0000000",
      price: "1",
    }));
    const server = ledgerServer(() => [
      accountLedgerEntry(SOURCE, { ...agreeing, numSubEntries: offers.length }),
      ...offers.map((o) =>
        offerLedgerEntry(SOURCE, BigInt(o.id), USDC, Asset.native(), 10_000_000n)
      ),
    ]);
    const enumerated = state({ numSubEntries: offers.length, openOffers: offers });
    const live = await readLiveLedger(server, enumerated);
    expect(server.calls).toEqual([RPC_LEDGER_KEY_LIMIT, 1]);
    expect(findStateDrift(enumerated, live)).toBeNull();
  });

  test("a failed read is a retryable error, never an unchanged account", async () => {
    const server = { getLedgerEntries: () => Promise.reject(new Error("rpc down")) };
    await expect(readLiveLedger(server as never, state())).rejects.toBeInstanceOf(LiveReadError);
  });

  test("a malformed response is a retryable error", async () => {
    const server = { getLedgerEntries: () => Promise.resolve({ latestLedger: 1 }) };
    await expect(readLiveLedger(server as never, state())).rejects.toBeInstanceOf(LiveReadError);
  });

  test("an entry the read did not ask for is a malformed response", async () => {
    const stranger = Keypair.random().publicKey();
    const server = {
      getLedgerEntries: async () => ({
        latestLedger: 1,
        entries: [accountLedgerEntry(stranger, agreeing)],
      }),
    };
    await expect(readLiveLedger(server as never, state())).rejects.toBeInstanceOf(LiveReadError);
  });
});

describe("the build round confirms the enumerated account over RPC", () => {
  beforeEach(() => stubIssuance());

  test("a newer sequence on the ledger refuses the round with state_changed 409 and no transaction", async () => {
    useLedger({ ...agreeing, sequence: "9007199254740994" });
    const err = await build().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountStateChangedError);
    expect(mapDomainError(TRANSACTION_ERRORS, err)).toMatchObject({
      code: "state_changed",
      status: 409,
    });
    expect(mapDomainError(TRANSACTION_ERRORS, err)!.message).toContain("Nothing was submitted");
  });

  test("a different sub-entry count refuses the round with state_changed", async () => {
    useLedger({ ...agreeing, numSubEntries: 1 });
    await expect(build()).rejects.toBeInstanceOf(AccountStateChangedError);
  });

  test("an account the ledger no longer holds refuses the round with state_changed", async () => {
    useLedger(null);
    await expect(build()).rejects.toBeInstanceOf(AccountStateChangedError);
  });

  test("an agreeing ledger builds on the confirmed sequence", async () => {
    useLedger(agreeing);
    const result = await build();
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.sourceSequence).toBe(SEQUENCE);
  });

  test("a failed confirmation read fails the round closed", async () => {
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getLedgerEntries: () => Promise.reject(new Error("rpc down")),
      getLatestLedger: async () => ({ sequence: 1000 }),
    })) as unknown as typeof rpcModule.getRpcServer);
    await expect(build()).rejects.toBeInstanceOf(LiveReadError);
  });
});

describe("an RPC behind the snapshot, with more than one provider configured", () => {
  const realFallbacks = RPC_FALLBACKS.testnet;
  const realPrimary = RPC_URLS.testnet;
  const SNAPSHOT = 1000;

  beforeEach(() => {
    stubIssuance();
    RPC_URLS.testnet = "https://rpc-a.test";
    RPC_FALLBACKS.testnet = [{ url: "https://rpc-b.test", headers: {} }];
  });
  afterEach(() => {
    RPC_URLS.testnet = realPrimary;
    RPC_FALLBACKS.testnet = realFallbacks;
  });

  function atLedger(latestLedger: number) {
    const held = ledgerServer(() => [
      accountLedgerEntry(SOURCE, { ...agreeing, numSubEntries: 1 }),
    ]);
    const server = {
      ...held,
      getLedgerEntries: async (...keys: xdr.LedgerKey[]) => ({
        ...(await held.getLedgerEntries(...keys)),
        latestLedger,
      }),
    };
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      ...server,
      getLatestLedger: async () => ({ sequence: latestLedger }),
    })) as unknown as typeof rpcModule.getRpcServer);
    return server;
  }

  const snapshot = state({ snapshotLedger: SNAPSHOT });
  const buildFrom = (from: AccountState) => buildCloseTransactions(from, DEST, {}, "testnet");

  test("a drift the RPC has not reached yet is a 503, not a change of state", async () => {
    atLedger(SNAPSHOT - 1);
    const failure = await buildFrom(snapshot).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LiveReadError);
    expect(mapDomainError(TRANSACTION_ERRORS, failure)).toMatchObject({ status: 503 });
  });

  test("a drift from an RPC level with the snapshot stays a 409", async () => {
    atLedger(SNAPSHOT);
    const failure = await buildFrom(snapshot).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AccountStateChangedError);
    expect(mapDomainError(TRANSACTION_ERRORS, failure)).toMatchObject({ status: 409 });
  });

  test("a drift from an RPC ahead of the snapshot stays a 409", async () => {
    await expect(confirmLedgerState(snapshot, atLedger(SNAPSHOT + 5), true)).rejects.toBeInstanceOf(
      AccountStateChangedError
    );
  });

  test("agreement passes even from an RPC behind the snapshot", async () => {
    const server = ledgerServer(() => [accountLedgerEntry(SOURCE, agreeing)]);
    expect(await confirmLedgerState(state({ snapshotLedger: 2000 }), server, true)).toBe(SEQUENCE);
  });

  test("the round settles its provider before building, so the Blend SDK can read it", async () => {
    const latest = spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(function (
      this: rpc.Server
    ) {
      if (this.serverURL.toString().includes("rpc-a")) return Promise.reject(new Error("down"));
      const closeTime = String(Math.floor(Date.now() / 1000));
      return Promise.resolve({ sequence: 1000, closeTime } as never);
    });
    useLedger(agreeing);
    const res = { setHeader() {}, json() {}, on() {} };
    const pinned = await new Promise<string>((resolve, reject) =>
      requestContextMiddleware()({ path: "/x" } as never, res as never, () => {
        buildFrom(snapshot)
          .then(() => resolve(pinnedRpcProvider("testnet").url))
          .catch(reject);
      })
    );
    latest.mockRestore();
    expect(pinned).toBe("https://rpc-b.test");
  });

  test("a lone RPC keeps the 409, however far behind", async () => {
    RPC_FALLBACKS.testnet = [];
    atLedger(SNAPSHOT - 1);
    await expect(buildFrom(snapshot)).rejects.toBeInstanceOf(AccountStateChangedError);
  });
});
