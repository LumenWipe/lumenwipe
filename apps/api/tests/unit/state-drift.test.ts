import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { mapDomainError, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { findStateDrift } from "@/lib/close-api/state-drift";
import { readLiveLedger } from "@/lib/stellar/live-ledger";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { AccountStateChangedError } from "@/lib/utils/errors";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { accountLedgerEntry, ledgerServer, type AccountEntrySpec } from "./fixtures/live-ledger";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const SEQUENCE = "9007199254740993";

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
  test("an account the ledger agrees with is no drift", async () => {
    const live = await readLiveLedger(
      ledgerServer(() => [accountLedgerEntry(SOURCE, agreeing)]),
      {
        address: SOURCE,
      }
    );
    expect(findStateDrift(state(), live)).toBeNull();
  });

  test("a sequence one above the enumerated one is drift, even beyond 2^53", () => {
    const live = {
      account: {
        sequence: "9007199254740994",
        numSubEntries: 0,
        thresholds: { master: 1, low: 0, med: 0, high: 0 },
        signers: [],
      },
    };
    expect(findStateDrift(state(), live)).toContain("sequence");
  });

  test("a different sub-entry count is drift", () => {
    const live = {
      account: {
        sequence: SEQUENCE,
        numSubEntries: 1,
        thresholds: { master: 1, low: 0, med: 0, high: 0 },
        signers: [],
      },
    };
    expect(findStateDrift(state(), live)).toContain("sub-entries");
  });

  test("an account the ledger no longer holds is drift", () => {
    expect(findStateDrift(state(), { account: null })).not.toBeNull();
  });
});

describe("readLiveLedger", () => {
  test("a failed read is a retryable error, never an unchanged account", async () => {
    const server = { getLedgerEntries: () => Promise.reject(new Error("rpc down")) };
    await expect(readLiveLedger(server as never, { address: SOURCE })).rejects.toBeInstanceOf(
      LiveReadError
    );
  });

  test("a malformed response is a retryable error", async () => {
    const server = { getLedgerEntries: () => Promise.resolve({ latestLedger: 1 }) };
    await expect(readLiveLedger(server as never, { address: SOURCE })).rejects.toBeInstanceOf(
      LiveReadError
    );
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
