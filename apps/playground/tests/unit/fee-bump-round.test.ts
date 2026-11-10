import { describe, expect, test } from "bun:test";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  LumenWipeApiError,
  type CloseTransaction,
  type DecisionPoint,
  type TransactionLookupResponse,
  type TransactionsResponse,
} from "@lumenwipe/sdk";
import { runCloseRound, type DemolishApi, type DemolishChain } from "@/lib/demolish";
import type { ScenarioSelection } from "@/lib/scenarios";
import { runDemolishRound } from "@/lib/session-actions";
import type { PlaygroundSession, SessionStore } from "@/lib/session-store";
import { expectationFromSession } from "@/lib/verify";
import { memoryStore, newSessionData } from "./session-fixtures";

// A sponsored close end to end inside the process: the real close engine, the real verifier held
// to a session that selected the sponsored fee, the sponsor's envelope checked in `prepare`, and the
// real session-actions writes. Only the LumenWipe API, its fee sponsor and the network are faked;
// the sponsor builds and signs real fee-bump envelopes, or tampers with them as a test asks.

const PASSPHRASE = Networks.TESTNET;
const noSleep = async (): Promise<void> => {};

const demo = Keypair.random();
const sink = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const feeAccount = Keypair.random();

const SPONSORED: ScenarioSelection = {
  scenarios: [
    { id: "data-entries", params: { count: 1 } },
    { id: "fee-bump", params: {} },
  ],
};

const MASTER_ONLY: DemolishChain = {
  signerState: async () => ({
    signers: [{ key: demo.publicKey(), type: "ed25519_public_key", weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
  }),
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const hashOf = (xdr: string): string => hex(TransactionBuilder.fromXdr(xdr, PASSPHRASE).hash());

function apiError(status: number, code: string): LumenWipeApiError {
  return new LumenWipeApiError(status, { error: { code, message: "fake" } });
}

const MAX_TIME = Math.floor(Date.now() / 1000) + 300;

/** The close the API builds: the data entry's removal and the merge, at `fee`. */
function closeTransaction(fee: string, destination = sink): CloseTransaction {
  const xdr = new TransactionBuilder(new Account(demo.publicKey(), "1"), {
    fee,
    networkPassphrase: PASSPHRASE,
  })
    .setTimebounds(0, MAX_TIME)
    .addOperation(Operation.manageData({ name: "promo_code", value: null }))
    .addOperation(Operation.accountMerge({ destination }))
    .build()
    .toEnvelope()
    .toXdr("base64");
  return {
    id: "close-1",
    order: 0,
    dependsOn: [],
    xdr,
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: ["REMOVE_DATA_ENTRIES", "MERGE"],
    ...(fee === "0" && { needsSponsoredFee: true }),
    intent: {
      summary: "Remove 1 data entry and close the account",
      source: demo.publicKey(),
      fee,
      memo: null,
      memoType: null,
      guarantees: { mergeDestination: sink, paymentsOnlyTo: [], minXlmFromConversions: null },
      operations: [],
    },
  };
}

type Sponsor = "sign" | "refuse" | "other-source" | "drop-signature" | "unsigned";

class FakeSponsoredApi implements DemolishApi {
  fee = "0";
  destination = sink;
  sponsor: Sponsor = "sign";
  closeError: LumenWipeApiError | null = null;
  landSilently = false;
  lookupSeesLanded = false;
  readonly landed = new Set<string>();
  readonly sponsored: string[] = [];
  readonly submitted: string[] = [];
  calls = { sponsor: 0, transactions: 0 };

  async closePlan(): Promise<{ decisionPoints: DecisionPoint[]; blockers: { code: string }[] }> {
    return { decisionPoints: [], blockers: [] };
  }

  async closeTransactions(): Promise<TransactionsResponse> {
    this.calls.transactions++;
    if (this.closeError) throw this.closeError;
    return {
      planHash: "plan",
      status: "ready",
      transactions: [closeTransaction(this.fee, this.destination)],
      remaining: { steps: 0, requiresAnotherCall: false },
    };
  }

  async feeBumpSponsor(signedXdr: string): Promise<{ transaction: string }> {
    this.calls.sponsor++;
    this.sponsored.push(signedXdr);
    if (this.sponsor === "refuse") throw apiError(429, "sponsorship_budget_exhausted");
    const inner = TransactionBuilder.fromXdr(signedXdr, PASSPHRASE) as Transaction;
    if (this.sponsor === "drop-signature") inner.signatures.splice(0);
    const other = Keypair.random();
    const source = this.sponsor === "other-source" ? other : feeAccount;
    const wrapped = TransactionBuilder.buildFeeBumpTransaction(source, "100", inner, PASSPHRASE);
    if (this.sponsor !== "unsigned") wrapped.sign(source);
    return { transaction: wrapped.toEnvelope().toXdr("base64") };
  }

  async submit(signedXdr: string): Promise<{ hash: string }> {
    this.submitted.push(signedXdr);
    const hash = hashOf(signedXdr);
    this.landed.add(hash);
    if (this.landSilently) throw apiError(504, "upstream_timeout");
    return { hash };
  }

  async getTransaction(hash: string): Promise<TransactionLookupResponse> {
    if (this.lookupSeesLanded && this.landed.has(hash)) {
      return { status: "confirmed", hash, ledger: 10 };
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      status: "not_found",
      hash,
      searched: {
        oldestLedger: 1,
        oldestLedgerCloseTime: now - 3600,
        latestLedger: 10,
        latestLedgerCloseTime: now,
      },
    };
  }
}

async function newSession(store: SessionStore, selection = SPONSORED): Promise<PlaygroundSession> {
  return store.createSession({ ...newSessionData(), demoPublic: demo.publicKey(), selection });
}

function round(
  store: SessionStore,
  id: string,
  api: FakeSponsoredApi,
  configured: string | null = feeAccount.publicKey()
) {
  return runDemolishRound(store, id, {
    round: (session, hooks) =>
      runCloseRound(
        api,
        MASTER_ONLY,
        {
          demoKeypair: demo,
          signingKeys: [],
          expected: expectationFromSession(session, sink, issuer, configured),
          apiUrl: "unused",
          apiKey: "unused",
          hooks,
        },
        noSleep
      ),
  });
}

describe("a sponsored close", () => {
  test("sends the signed close to the sponsor, then submits its envelope under the outer hash", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();

    const result = await round(store, session.id, api);

    expect(result.status).toBe(200);
    expect(result.body.done).toBe(true);
    expect(api.calls.sponsor).toBe(1);
    // The sponsor got the playground's own signed transaction, with its fee still zero.
    const signed = TransactionBuilder.fromXdr(api.sponsored[0]!, PASSPHRASE);
    expect(signed).toBeInstanceOf(Transaction);
    expect((signed as Transaction).fee).toBe("0");
    expect(signed.signatures).toHaveLength(1);
    // What went out is the fee-bump envelope around it, logged under the envelope's own hash.
    expect(api.submitted).toHaveLength(1);
    const sent = TransactionBuilder.fromXdr(api.submitted[0]!, PASSPHRASE);
    expect(sent).toBeInstanceOf(FeeBumpTransaction);
    const outer = hex(sent.hash());
    expect(hex((sent as FeeBumpTransaction).innerTransaction.hash())).toBe(hex(signed.hash()));
    expect(outer).not.toBe(hex(signed.hash()));
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishLog.map((e) => e.hash)).toEqual([outer]);
    expect(loaded?.demolishDone).toBe(true);
  });

  test("an outcome lost in flight is recorded under the outer hash and settled by it", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();
    api.landSilently = true;

    const unknown = await round(store, session.id, api);
    expect(unknown).toEqual({ status: 502, body: { error: "demolish_outcome_unknown" } });
    const pending = (await store.loadSession(session.id))?.demolishPending;
    const outer = hashOf(api.submitted[0]!);
    // The record names the outer hash, and reads the merge and the expiry from the inner one.
    expect(pending?.hash).toBe(outer);
    expect(pending?.closesAccount).toBe(true);
    expect(pending?.validUntil).toBe(MAX_TIME);

    api.lookupSeesLanded = true;
    const resumed = await round(store, session.id, api);
    expect(resumed.body.done).toBe(true);
    expect(api.calls.sponsor).toBe(1);
    expect(api.calls.transactions).toBe(1);
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishLog.map((e) => e.hash)).toEqual([outer]);
    expect(loaded?.demolishPending).toBeNull();
  });

  test("a close the demo pays for itself is never sent to the sponsor", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();
    api.fee = "200";

    const result = await round(store, session.id, api);
    expect(result.body.done).toBe(true);
    expect(api.calls.sponsor).toBe(0);
    expect(TransactionBuilder.fromXdr(api.submitted[0]!, PASSPHRASE)).toBeInstanceOf(Transaction);
  });

  test("a sponsor refusal sends nothing and leaves nothing in flight", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();
    api.sponsor = "refuse";

    const result = await round(store, session.id, api);
    expect(result).toEqual({ status: 502, body: { error: "demolish_fee_unsponsored" } });
    expect(api.submitted).toEqual([]);
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishPending).toBeNull();
    expect(loaded?.demolishDone).toBe(false);
  });

  test("an API that will not sponsor a drained demo is reported the same way", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();
    api.closeError = apiError(422, "close_fee_balance_short");
    expect(await round(store, session.id, api)).toEqual({
      status: 502,
      body: { error: "demolish_fee_unsponsored" },
    });
    // Outside a sponsored session it is the close failing like any other refusal.
    const plain = await newSession(store, { scenarios: [{ id: "data-entries", params: {} }] });
    expect(await round(store, plain.id, api)).toEqual({
      status: 502,
      body: { error: "demolish_failed" },
    });
  });

  test("an envelope that fails its check is never submitted", async () => {
    for (const sponsor of ["other-source", "drop-signature", "unsigned"] as const) {
      const store = memoryStore();
      const session = await newSession(store);
      const api = new FakeSponsoredApi();
      api.sponsor = sponsor;

      const result = await round(store, session.id, api);
      expect({ sponsor, result }).toEqual({
        sponsor,
        result: { status: 502, body: { error: "demolish_failed" } },
      });
      expect(api.calls.sponsor).toBe(1);
      expect(api.submitted).toEqual([]);
      expect((await store.loadSession(session.id))?.demolishPending).toBeNull();
    }
  });

  test("an inner transaction that breaks a normal rule is refused before the sponsor sees it", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();
    api.destination = Keypair.random().publicKey();

    const result = await round(store, session.id, api);
    expect(result.status).toBe(502);
    expect(api.calls.sponsor).toBe(0);
    expect(api.submitted).toEqual([]);
  });

  test("a zero fee is refused when this deployment has no fee account configured", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi();

    const result = await round(store, session.id, api, null);
    expect(result).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect(api.calls.sponsor).toBe(0);
    expect(api.submitted).toEqual([]);
  });
});
