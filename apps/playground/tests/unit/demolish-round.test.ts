import { describe, expect, test } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  LumenWipeApiError,
  type CloseTransaction,
  type DecisionPoint,
  type TransactionLookupResponse,
  type TransactionsResponse,
} from "@lumenwipe/sdk";
import { runCloseRound, type DemolishApi, type DemolishChain } from "@/lib/demolish";
import { runDemolishRound } from "@/lib/session-actions";
import type { PlaygroundSession, SessionStore } from "@/lib/session-store";
import { expectationFromSession } from "@/lib/verify";
import { memoryStore, newSessionData } from "./session-fixtures";

// A demolish round end to end inside the process: the real close engine (`runClose`), the real
// verifier held to the session record, and the real session-actions writes over the in-memory
// store. Only the LumenWipe API and the network are faked, by `FakeApi` below, which builds real
// envelopes and keeps a ledger of what landed. Each test stops a round at one point where a
// request can die and checks that the next round finishes the close without building or sending
// a confirmed transaction again.

const PASSPHRASE = Networks.TESTNET;
const noSleep = async (): Promise<void> => {};

const demo = Keypair.random();
const sink = Keypair.random().publicKey();
const lwdemoIssuer = Keypair.random().publicKey();
const DATA_KEY = "promo_code";

/** The demo as the playground creates it: its master key alone, every threshold 0. */
const MASTER_ONLY: DemolishChain = {
  signerState: async () => ({
    signers: [{ key: demo.publicKey(), type: "ed25519_public_key", weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
  }),
};

const hashOf = (xdr: string): string =>
  Buffer.from(TransactionBuilder.fromXdr(xdr, PASSPHRASE).hash()).toString("hex");

function apiError(status: number, code: string): LumenWipeApiError {
  return new LumenWipeApiError(status, { error: { code, message: "fake" } });
}

/** The close the API builds for the session: remove the data entry, then merge into the sink. */
function closeTransaction(merge = true): CloseTransaction {
  const builder = new TransactionBuilder(new Account(demo.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  }).setTimebounds(0, Math.floor(Date.now() / 1000) + 300);
  builder.addOperation(Operation.manageData({ name: DATA_KEY, value: null }));
  if (merge) builder.addOperation(Operation.accountMerge({ destination: sink }));
  return {
    id: "close-1",
    order: 0,
    dependsOn: [],
    xdr: builder.build().toEnvelope().toXdr("base64"),
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: merge ? ["REMOVE_DATA_ENTRIES", "MERGE"] : ["REMOVE_DATA_ENTRIES"],
    intent: {
      summary: merge ? "Remove 1 data entry and close the account" : "Remove 1 data entry",
      source: demo.publicKey(),
      fee: "100",
      memo: null,
      memoType: null,
      guarantees: {
        mergeDestination: merge ? sink : null,
        paymentsOnlyTo: [],
        minXlmFromConversions: null,
      },
      operations: [],
    },
  };
}

type SubmitBehavior =
  /** Lands, and the answer comes back. */
  | "confirm"
  /** Lands, but every answer is lost: the outcome is unknown until a lookup finds it. */
  | "land-silently"
  /** Refused before it could land (a 4xx). */
  | "refuse";

class FakeApi implements DemolishApi {
  accountOpen = true;
  readonly landed = new Set<string>();
  /** Lookups answer `not_found` until this is set, as a lagging read would. */
  lookupSeesLanded = false;
  submitBehavior: SubmitBehavior = "confirm";
  buildsMerge = true;
  /** The decision points the plan asks for. */
  decisionPoints: DecisionPoint[] = [];
  /** The blockers the plan reports. */
  blockers: { code: string }[] = [];
  calls = { plan: 0, transactions: 0, submit: 0, lookup: 0 };
  /** Called whenever a transaction lands, to stop the request there. */
  onLanded: () => void = () => {};

  async closePlan(): Promise<{ decisionPoints: DecisionPoint[]; blockers: { code: string }[] }> {
    this.calls.plan++;
    if (!this.accountOpen) throw apiError(404, "account_not_found");
    return { decisionPoints: this.decisionPoints, blockers: this.blockers };
  }

  async closeTransactions(): Promise<TransactionsResponse> {
    this.calls.transactions++;
    if (!this.accountOpen) throw apiError(404, "account_not_found");
    return {
      planHash: "plan",
      status: "ready",
      transactions: [closeTransaction(this.buildsMerge)],
      remaining: { steps: this.buildsMerge ? 0 : 1, requiresAnotherCall: !this.buildsMerge },
    };
  }

  async submit(signedXdr: string): Promise<{ hash: string }> {
    this.calls.submit++;
    const hash = hashOf(signedXdr);
    if (this.landed.has(hash)) throw apiError(503, "upstream_error");
    if (this.submitBehavior === "refuse") throw apiError(400, "tx_bad_seq");
    this.landed.add(hash);
    this.accountOpen = false;
    this.onLanded();
    if (this.submitBehavior === "land-silently") throw apiError(504, "upstream_timeout");
    return { hash };
  }

  async getTransaction(hash: string): Promise<TransactionLookupResponse> {
    this.calls.lookup++;
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

/** A store that dies at a chosen moment: every write after it fails, as when the platform kills
 *  the request. */
function mortal(store: SessionStore): { store: SessionStore; die: () => void } {
  let dead = false;
  return {
    store: {
      ...store,
      updateSession: async (lock, patch) => {
        if (dead) throw new Error("request killed");
        return store.updateSession(lock, patch);
      },
    },
    die: () => {
      dead = true;
    },
  };
}

async function newSession(store: SessionStore): Promise<PlaygroundSession> {
  return store.createSession({
    ...newSessionData(),
    demoPublic: demo.publicKey(),
    selection: { scenarios: [{ id: "data-entries", params: { count: 1 } }] },
  });
}

function round(store: SessionStore, id: string, api: FakeApi) {
  return runDemolishRound(store, id, {
    round: (session, hooks) =>
      runCloseRound(
        api,
        MASTER_ONLY,
        {
          demoKeypair: demo,
          signingKeys: [],
          expected: expectationFromSession(session, sink, lwdemoIssuer),
          apiUrl: "unused",
          apiKey: "unused",
          hooks,
        },
        noSleep
      ),
  });
}

describe("a demolish round resumes from where a request died", () => {
  test("a single round closes the account and logs its transaction", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeApi();

    const result = await round(store, session.id, api);

    expect(result.status).toBe(200);
    expect(result.body.done).toBe(true);
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishLog.map((e) => e.txId)).toEqual(["close-1"]);
    expect(loaded?.demolishLog[0]?.hash).toBe([...api.landed][0]);
    expect(loaded?.demolishPending).toBeNull();
    expect(loaded?.demolishDone).toBe(true);
  });

  test("a transaction whose outcome was unknown is settled by its hash, never sent again", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeApi();
    api.submitBehavior = "land-silently";

    const unknown = await round(store, session.id, api);
    expect(unknown).toEqual({ status: 502, body: { error: "demolish_outcome_unknown" } });
    const inFlight = (await store.loadSession(session.id))?.demolishPending;
    expect(inFlight?.hash).toBe([...api.landed][0]);
    expect(inFlight?.closesAccount).toBe(true);
    expect(api.landed.size).toBe(1);

    api.lookupSeesLanded = true;
    const resumed = await round(store, session.id, api);

    expect(resumed.body.done).toBe(true);
    expect(resumed.body.confirmed).toEqual([
      expect.objectContaining({ txId: "close-1", hash: inFlight?.hash }),
    ]);
    expect(api.landed.size).toBe(1);
    expect(api.calls.transactions).toBe(1);
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishLog).toHaveLength(1);
    expect(loaded?.demolishPending).toBeNull();
    expect(loaded?.demolishDone).toBe(true);
  });

  test("a merge that confirmed before it was logged is logged once by the next round", async () => {
    const base = memoryStore();
    const { store, die } = mortal(base);
    const session = await newSession(base);
    const api = new FakeApi();
    api.onLanded = die;

    const killed = await round(store, session.id, api);
    expect(killed.status).toBe(502);
    const afterKill = await base.loadSession(session.id);
    expect(afterKill?.demolishLog).toEqual([]);
    expect(afterKill?.demolishDone).toBe(false);
    expect(afterKill?.demolishPending?.hash).toBe([...api.landed][0]);

    api.lookupSeesLanded = true;
    const resumed = await round(base, session.id, api);

    expect(resumed.body.done).toBe(true);
    expect(api.landed.size).toBe(1);
    expect(api.calls.submit).toBe(1);
    expect(api.calls.transactions).toBe(1);
    const loaded = await base.loadSession(session.id);
    expect(loaded?.demolishLog.map((e) => e.hash)).toEqual([...api.landed]);
    expect(loaded?.demolishPending).toBeNull();
    expect(loaded?.demolishDone).toBe(true);
  });

  test("a merge whose log write failed while the request lived is still logged", async () => {
    const base = memoryStore();
    let failLogWrite = true;
    const store: SessionStore = {
      ...base,
      updateSession: async (lock, patch) => {
        const current = await base.loadSession(lock.sessionId);
        if (failLogWrite && current && patch(current).demolishLog) {
          failLogWrite = false;
          throw new Error("store unavailable");
        }
        return base.updateSession(lock, patch);
      },
    };
    const session = await newSession(base);
    const api = new FakeApi();

    const result = await round(store, session.id, api);

    expect(result.body.done).toBe(true);
    const loaded = await base.loadSession(session.id);
    expect(loaded?.demolishLog.map((e) => e.hash)).toEqual([...api.landed]);
    expect(loaded?.demolishPending).toBeNull();
    expect(loaded?.demolishDone).toBe(true);
  });

  test("a transaction refused before it landed is cleared, and the next round builds afresh", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeApi();
    api.submitBehavior = "refuse";

    const refused = await round(store, session.id, api);
    expect(refused).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect((await store.loadSession(session.id))?.demolishPending).toBeNull();

    api.submitBehavior = "confirm";
    const resumed = await round(store, session.id, api);
    expect(resumed.body.done).toBe(true);
    expect(api.calls.transactions).toBe(2);
    expect((await store.loadSession(session.id))?.demolishLog).toHaveLength(1);
  });

  test("a round that is not the final merge is refused before it is signed or sent", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeApi();
    api.buildsMerge = false;

    const result = await round(store, session.id, api);

    expect(result).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect(api.calls.submit).toBe(0);
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishPending).toBeNull();
    expect(loaded?.demolishLog).toEqual([]);
  });

  test("a decision the playground cannot make stops the round before anything is built", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeApi();
    api.decisionPoints = [
      {
        id: "defi_positions:GDEMO",
        type: "confirmation",
        subject: { kind: "defi_positions" },
        options: [{ id: "no_defi_positions_confirmed_manually" }],
        default: "",
        required: true,
      },
    ];

    const result = await round(store, session.id, api);

    expect(result).toEqual({
      status: 422,
      body: { error: "demolish_decision_unanswerable", decisions: ["defi_positions:GDEMO"] },
    });
    expect([api.calls.transactions, api.calls.submit]).toEqual([0, 0]);
    expect((await store.loadSession(session.id))?.demolishPending).toBeNull();
  });

  test("a plan blocker stops the round before anything is built, naming what the session can resolve", async () => {
    const store = memoryStore();
    const session = await store.createSession({
      ...newSessionData(),
      demoPublic: demo.publicKey(),
      selection: {
        scenarios: [{ id: "claimable-balances", params: { add_trustline: 0, demo_sponsored: 1 } }],
      },
    });
    const api = new FakeApi();
    api.blockers = [
      { code: "sponsorship_claimable_balance_unrevocable" },
      { code: "sponsorship_claimable_balance_unrevocable" },
      { code: "subentries_unenumerated" },
    ];

    const result = await runDemolishRound(store, session.id, {
      round: (s, hooks) =>
        runCloseRound(
          api,
          MASTER_ONLY,
          {
            demoKeypair: demo,
            signingKeys: [],
            expected: expectationFromSession(
              {
                ...s,
                ephemeralIssuers: [{ assetCode: "BONUS", publicKey: lwdemoIssuer, encSecret: "e" }],
              },
              sink,
              lwdemoIssuer
            ),
            apiUrl: "unused",
            apiKey: "unused",
            hooks,
          },
          noSleep
        ),
    });

    expect(result).toEqual({
      status: 422,
      body: {
        error: "demolish_blocked",
        blockers: ["sponsorship_claimable_balance_unrevocable", "subentries_unenumerated"],
        resolvable: ["sponsorship_claimable_balance_unrevocable"],
      },
    });
    expect([api.calls.transactions, api.calls.submit]).toEqual([0, 0]);
  });

  test("a forfeited balance's blocker is the one the close builds past", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeApi();
    api.blockers = [{ code: "claimable_balance_forfeited" }];
    const result = await round(store, session.id, api);
    expect(result.body.done).toBe(true);
  });
});
