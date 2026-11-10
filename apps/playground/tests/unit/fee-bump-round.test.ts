import { describe, expect, test } from "bun:test";
import {
  FeeBumpTransaction,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { runCloseRound, type DemolishChain } from "@/lib/demolish";
import type { ScenarioSelection } from "@/lib/scenarios";
import { runDemolishRound } from "@/lib/session-actions";
import type { PlaygroundSession, SessionStore } from "@/lib/session-store";
import { expectationFromSession } from "@/lib/verify";
import { apiError, FakeSponsoredApi, hashOf, hex, MAX_TIME } from "./fee-bump-fixtures";
import { memoryStore, newSessionData } from "./session-fixtures";

// A sponsored close end to end inside the process: the real close engine, the real verifier held
// to a session that selected the sponsored fee, the sponsor's envelope checked in `prepare`, and the
// real session-actions writes. Only the LumenWipe API, its fee sponsor and the network are faked;
// the sponsor (./fee-bump-fixtures) builds and signs real fee-bump envelopes, or tampers with them.

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

async function newSession(store: SessionStore, selection = SPONSORED): Promise<PlaygroundSession> {
  return store.createSession({ ...newSessionData(), demoPublic: demo.publicKey(), selection });
}

/** The demo key, counting every signature it makes. */
function countingDemo(): { keypair: Keypair; signatures: () => number } {
  const keypair = Keypair.fromSecret(demo.secret());
  const signDecorated = keypair.signDecorated.bind(keypair);
  let count = 0;
  keypair.signDecorated = (data) => {
    count++;
    return signDecorated(data);
  };
  return { keypair, signatures: () => count };
}

function round(
  store: SessionStore,
  id: string,
  api: FakeSponsoredApi,
  configured: string | null = feeAccount.publicKey(),
  demoKeypair: Keypair = demo
) {
  return runDemolishRound(store, id, {
    round: (session, hooks) =>
      runCloseRound(
        api,
        MASTER_ONLY,
        {
          demoKeypair,
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
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);

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
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
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
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
    api.fee = "200";

    const result = await round(store, session.id, api);
    expect(result.body.done).toBe(true);
    expect(api.calls.sponsor).toBe(0);
    expect(TransactionBuilder.fromXdr(api.submitted[0]!, PASSPHRASE)).toBeInstanceOf(Transaction);
  });

  test("a sponsor refusal sends nothing and leaves nothing in flight", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
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
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
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
      const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
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
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
    api.destination = Keypair.random().publicKey();

    const result = await round(store, session.id, api);
    expect(result.status).toBe(502);
    expect(api.calls.sponsor).toBe(0);
    expect(api.submitted).toEqual([]);
  });

  test("with no fee account configured, a drained session's zero-fee close is unsponsored, unsigned", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
    const spy = countingDemo();

    const result = await round(store, session.id, api, null, spy.keypair);
    expect(result).toEqual({ status: 502, body: { error: "demolish_fee_unsponsored" } });
    expect(spy.signatures()).toBe(0);
    expect(api.calls.sponsor).toBe(0);
    expect(api.submitted).toEqual([]);
    expect((await store.loadSession(session.id))?.demolishPending).toBeNull();
  });

  test("with no fee account configured, a drained session the API calls short is unsponsored", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
    api.closeError = apiError(422, "close_fee_balance_short");
    const spy = countingDemo();

    const result = await round(store, session.id, api, null, spy.keypair);
    expect(result).toEqual({ status: 502, body: { error: "demolish_fee_unsponsored" } });
    expect(spy.signatures()).toBe(0);
    expect(api.submitted).toEqual([]);
  });

  test("a zero-fee close in a session that did not select the sponsored fee is a hard refusal", async () => {
    const store = memoryStore();
    const session = await newSession(store, { scenarios: [{ id: "data-entries", params: {} }] });
    const api = new FakeSponsoredApi(demo.publicKey(), sink, feeAccount);
    for (const configured of [feeAccount.publicKey(), null]) {
      const spy = countingDemo();
      const result = await round(store, session.id, api, configured, spy.keypair);
      expect(result).toEqual({ status: 502, body: { error: "demolish_failed" } });
      expect(spy.signatures()).toBe(0);
    }
    expect(api.calls.sponsor).toBe(0);
    expect(api.submitted).toEqual([]);
  });
});
