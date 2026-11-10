import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { NextRequest } from "next/server";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { requiresMediator } from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { buildDemolishDecisions, planAnswers, runCloseRound } from "@/lib/demolish";
import { ensureAccountFromMarketMaker } from "@/lib/market-maker";
import { handleCreateSession, newExchangeMemo } from "@/lib/route-handlers";
import {
  EXCHANGE_STAND_IN,
  EXCHANGE_STAND_IN_FUNDING_XLM,
  closesToExchange,
  validateSelection,
  type ScenarioSelection,
} from "@/lib/scenarios";
import { runDemolishRound } from "@/lib/session-actions";
import type { PlaygroundSession, SessionStore } from "@/lib/session-store";
import {
  expectationFromSession,
  PlaygroundVerificationError,
  verifyDemolishTransaction,
  withRecordedBalance,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";
import {
  assertCosignedEnvelope,
  assertDeliveredOnLedger,
  FORWARD_TOLERANCE_STROOPS,
  forwardFloorStroops,
} from "@/lib/verify-mediator";
import { formatStroops } from "@/lib/stroops";
import exchangeFixture from "../fixtures/api-recipe-exchange.json";
import { FakeExchangeApi } from "./exchange-fixtures";
import { memoryStore, newSessionData } from "./session-fixtures";

// The exchange close: the bundled registry's testnet stand-in as the destination, the API's relay
// hand-off held to lib/verify-mediator.ts and the shared verifier, the mediator's co-signature
// checked before anything is sent, and the payment read back from the ledger by its hash. Keys
// are generated per run; the API and the network are faked (./exchange-fixtures) except for the
// recipe fixture, which apps/api's playground-exchange-recipe test builds with the real builder
// and the real mediator.

const PASSPHRASE = Networks.TESTNET;
const STAND_IN = EXCHANGE_STAND_IN.address;

class Refused extends Error {}

/** The code a refusal carries, or a failure when it is not the playground's own. */
function refusal(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof PlaygroundVerificationError) return err.message;
    throw new Refused(`refused by another check: ${String(err)}`);
  }
  throw new Refused("accepted");
}

describe("the stand-in", () => {
  test("is the bundled registry's testnet-only relay exchange, and the API's own entry", () => {
    expect(requiresMediator(STAND_IN, "testnet")).toBe(true);
    expect(requiresMediator(STAND_IN, "mainnet")).toBe(false);
    expect(exchangeFixture.standIn).toEqual({
      address: STAND_IN,
      name: EXCHANGE_STAND_IN.name,
      requiresMediator: true,
      requiresMemo: true,
      memoType: EXCHANGE_STAND_IN.memoType,
      network: "testnet",
    });
  });

  test("the scenario closes to it beside anything but the sponsored fee", () => {
    const pick = (...ids: string[]): ScenarioSelection => ({
      scenarios: ids.map((id) => ({ id: id as never, params: {} })),
    });
    expect(closesToExchange(pick("exchange-close"))).toBe(true);
    expect(closesToExchange(pick("data-entries"))).toBe(false);
    expect(validateSelection(pick("exchange-close")).ok).toBe(true);
    expect(validateSelection(pick("data-entries", "fee-bump", "exchange-close"))).toEqual({
      ok: false,
      message: "Exchange deposit cannot be combined with Sponsored fee.",
    });
    for (const id of ["multisig", "claimable-balances", "dispositions", "phoenix-lp"]) {
      expect({ id, ok: validateSelection(pick(id, "exchange-close")).ok }).toEqual({
        id,
        ok: true,
      });
    }
  });
});

describe("the API recipe", () => {
  const NOW = exchangeFixture.builtAtSeconds;
  beforeEach(() => setSystemTime(new Date(NOW * 1000)));
  afterEach(() => setSystemTime());

  const [recipe] = exchangeFixture.recipes;
  const fixtureExpectation = (): PlaygroundCloseExpectation =>
    expectationFromSession(
      {
        ...newSessionData(),
        demoPublic: recipe!.session.demoPublic,
        selection: recipe!.selection as ScenarioSelection,
        exchange: recipe!.session.exchange as PlaygroundSession["exchange"],
      },
      recipe!.session.sinkPublic,
      recipe!.session.persistentIssuer,
      null
    );

  test("the cleanup and the hand-off the API builds pass both checks, each at its round's balance", () => {
    expect(recipe!.requiresAnotherCall).toEqual([true, false]);
    recipe!.transactions.forEach((xdr, i) => {
      const expected = withRecordedBalance(fixtureExpectation(), recipe!.balances[i]!);
      expect(() => verifyDemolishTransaction({ xdr } as CloseTransaction, expected)).not.toThrow();
    });
  });

  test("the API mediator's co-signature passes the envelope check, and so does its ledger record", () => {
    expect(() =>
      assertCosignedEnvelope(recipe!.signed, recipe!.cosigned, recipe!.relay)
    ).not.toThrow();
    const exchange = withRecordedBalance(fixtureExpectation(), recipe!.balances[1]!).exchange!;
    expect(() =>
      assertDeliveredOnLedger(
        { successful: true, envelopeXdr: recipe!.cosigned },
        recipe!.session.demoPublic,
        exchange
      )
    ).not.toThrow();
  });

  test("the hand-off held to the cleanup's balance instead of its own is refused", () => {
    const expected = withRecordedBalance(fixtureExpectation(), "31.0000000");
    expect(
      refusal(() =>
        verifyDemolishTransaction({ xdr: recipe!.transactions[1]! } as CloseTransaction, expected)
      )
    ).toBe("exchange_forward_short");
  });
});

// Transactions built here, against a session of two data entries closing into the stand-in. The
// clock is fixed inside the bundled registry's verification window, which an exchange close is
// checked against.
const NOW = 1_793_000_000;
const demo = Keypair.random();
const relay = Keypair.random();
const sink = Keypair.random().publicKey();
const persistentIssuer = Keypair.random().publicKey();
const MEMO = "123";
const BALANCE = "30.0000000";
const SELECTION: ScenarioSelection = {
  scenarios: [
    { id: "data-entries", params: { count: 2 } },
    { id: "exchange-close", params: {} },
  ],
};

function exchangeSession(over: Partial<PlaygroundSession> = {}) {
  return {
    ...newSessionData(),
    demoPublic: demo.publicKey(),
    selection: SELECTION,
    exchange: { destination: STAND_IN, memo: MEMO, memoType: "id" as const },
    ...over,
  };
}

function expected(
  balance: string | null = BALANCE,
  over: Partial<PlaygroundSession> = {}
): PlaygroundCloseExpectation {
  const base = expectationFromSession(exchangeSession(over), sink, persistentIssuer, null);
  return balance === null ? base : withRecordedBalance(base, balance);
}

function build(ops: xdr.Operation[], memo: Memo = Memo.none()): CloseTransaction {
  const builder = new TransactionBuilder(new Account(demo.publicKey(), "1"), {
    fee: "200",
    networkPassphrase: PASSPHRASE,
  }).setTimebounds(0, NOW + 300);
  if (memo.type !== "none") builder.addMemo(memo);
  for (const op of ops) builder.addOperation(op);
  return { xdr: builder.build().toEnvelope().toXdr("base64") } as CloseTransaction;
}

const merge = (destination = relay.publicKey()): xdr.Operation =>
  Operation.accountMerge({ destination });

function forward({
  amount = "29.9999800",
  to = STAND_IN,
  from = relay.publicKey(),
  asset = Asset.native(),
}: { amount?: string; to?: string; from?: string; asset?: Asset } = {}): xdr.Operation {
  return Operation.payment({ source: from, destination: to, asset, amount });
}

const handOff = (fwd = forward(), memo: Memo = Memo.id(MEMO), into = relay.publicKey()) =>
  build([merge(into), fwd], memo);

const removeData = (name: string): xdr.Operation => Operation.manageData({ name, value: null });

const verify =
  (tx: CloseTransaction, exp = expected()) =>
  () =>
    verifyDemolishTransaction(tx, exp);

describe("the relay hand-off", () => {
  beforeEach(() => setSystemTime(new Date(NOW * 1000)));
  afterEach(() => setSystemTime());

  test("is accepted: merge into the relay, the relay forwards the balance to the stand-in with the memo", () => {
    expect(verify(handOff())).not.toThrow();
  });

  test("a forward to another address is refused, even the relay's own", () => {
    for (const to of [Keypair.random().publicKey(), sink, relay.publicKey()]) {
      expect(refusal(verify(handOff(forward({ to }))))).toBe(
        "exchange_forward_destination_mismatch"
      );
    }
  });

  test("a forward below the recorded balance less 0.01 XLM is refused, and one at exactly that floor is accepted", () => {
    const floor = forwardFloorStroops(BALANCE);
    expect(floor).toBe(BigInt(300_000_000) - FORWARD_TOLERANCE_STROOPS);
    expect(verify(handOff(forward({ amount: formatStroops(floor) })))).not.toThrow();
    expect(refusal(verify(handOff(forward({ amount: formatStroops(floor - BigInt(1)) }))))).toBe(
      "exchange_forward_short"
    );
    expect(refusal(verify(handOff(forward({ amount: "1.0000000" }))))).toBe(
      "exchange_forward_short"
    );
  });

  test("a forward above the recorded balance is refused", () => {
    expect(verify(handOff(forward({ amount: BALANCE })))).not.toThrow();
    expect(refusal(verify(handOff(forward({ amount: "30.0000001" }))))).toBe(
      "exchange_forward_above_balance"
    );
  });

  test("the floor is the balance this round recorded, and no merge is signed without one", () => {
    expect(refusal(verify(handOff(), expected("31.0000000")))).toBe("exchange_forward_short");
    expect(refusal(verify(handOff(), expected(null)))).toBe("exchange_balance_not_recorded");
  });

  test("a forward in anything but XLM is refused", () => {
    const asset = new Asset("LWDEMO", persistentIssuer);
    expect(refusal(verify(handOff(forward({ asset }))))).toBe("exchange_forward_not_native");
  });

  test("a forward sent by another account than the one the merge paid into is refused", () => {
    for (const from of [Keypair.random().publicKey(), demo.publicKey()]) {
      expect(refusal(verify(handOff(forward({ from }))))).toBe("exchange_forward_source_mismatch");
    }
    // The forward with no source of its own is sent by the demo.
    const sourceless = Operation.payment({
      destination: STAND_IN,
      asset: Asset.native(),
      amount: "29.9999800",
    });
    expect(refusal(verify(build([merge(), sourceless], Memo.id(MEMO))))).toBe(
      "exchange_forward_source_mismatch"
    );
  });

  test("a relay that is one of the session's own accounts is refused", () => {
    const recipient = Keypair.random().publicKey();
    const exp = expected(BALANCE, {
      transferRecipient: { publicKey: recipient, encSecret: "enc" },
    });
    for (const account of [sink, persistentIssuer, recipient, demo.publicKey()]) {
      const tx = handOff(forward({ from: account }), Memo.id(MEMO), account);
      expect({ account, code: refusal(verify(tx, exp)) }).toEqual({
        account,
        code: "exchange_relay_is_session_account",
      });
    }
  });

  test("a memo with another value is refused", () => {
    expect(refusal(verify(handOff(forward(), Memo.id("124"))))).toBe(
      "exchange_memo_value_mismatch"
    );
  });

  test("a text memo of the same digits is not the id memo", () => {
    expect(refusal(verify(handOff(forward(), Memo.text("123"))))).toBe(
      "exchange_memo_type_mismatch"
    );
    expect(
      refusal(verify(handOff(forward(), Memo.hash(Buffer.alloc(32, 1).toString("hex")))))
    ).toBe("exchange_memo_type_mismatch");
  });

  test("a hand-off without a memo is refused", () => {
    expect(refusal(verify(handOff(forward(), Memo.none())))).toBe("exchange_memo_missing");
  });

  test("a merge straight into the stand-in is refused, alone or after a cleanup", () => {
    expect(refusal(verify(build([merge(STAND_IN)], Memo.id(MEMO))))).toBe(
      "exchange_direct_merge_refused"
    );
    expect(refusal(verify(build([removeData("a"), merge(STAND_IN)], Memo.id(MEMO))))).toBe(
      "exchange_direct_merge_refused"
    );
    expect(refusal(verify(handOff(forward(), Memo.id(MEMO), STAND_IN)))).toBe(
      "exchange_direct_merge_refused"
    );
  });

  test("three operations are refused: a merge anywhere but in the two-operation hand-off", () => {
    const extra = forward({ to: Keypair.random().publicKey(), amount: "0.0000001" });
    expect(refusal(verify(build([merge(), forward(), extra], Memo.id(MEMO))))).toBe(
      "exchange_cleanup_merges"
    );
    expect(refusal(verify(build([removeData("a"), merge(), forward()], Memo.id(MEMO))))).toBe(
      "exchange_cleanup_merges"
    );
    // Two operations, but the second is not the forward.
    expect(refusal(verify(build([merge(), removeData("a")], Memo.id(MEMO))))).toBe(
      "exchange_handoff_shape"
    );
  });

  test("a merge into the market maker is no hand-off", () => {
    expect(refusal(verify(build([removeData("a"), merge(sink)])))).toBe("exchange_cleanup_merges");
  });
});

describe("the cleanup round", () => {
  beforeEach(() => setSystemTime(new Date(NOW * 1000)));
  afterEach(() => setSystemTime());

  test("is accepted: it removes the session's entries and neither merges nor carries a memo", () => {
    expect(verify(build([removeData("a"), removeData("b")]))).not.toThrow();
  });

  test("a memo on it is refused, the session's own included", () => {
    for (const memo of [Memo.id(MEMO), Memo.text("hello")]) {
      expect(refusal(verify(build([removeData("a")], memo)))).toBe("exchange_cleanup_memo");
    }
  });

  test("keeps the operation cap: no more operations than the session's entries explain", () => {
    expect(verify(build([removeData("a"), removeData("b"), removeData("c")]))).not.toThrow();
    expect(
      refusal(verify(build([removeData("a"), removeData("b"), removeData("c"), removeData("d")])))
    ).toBe("too_many_operations");
  });

  test("keeps the recorded-amount caps: a transfer moves no more than the mess paid in", () => {
    const recipient = Keypair.random().publicKey();
    const selection: ScenarioSelection = {
      scenarios: [
        { id: "dispositions", params: { lwcoin: 2, lwgem: 0 } },
        { id: "exchange-close", params: {} },
      ],
    };
    const exp = expected(BALANCE, {
      selection,
      transferRecipient: { publicKey: recipient, encSecret: "enc" },
    });
    const [transfer] = exp.transfers;
    expect(transfer?.destination).toBe(recipient);
    const lwcoin = new Asset("LWCOIN", persistentIssuer);
    const pay = (amount: string) =>
      Operation.payment({ destination: recipient, asset: lwcoin, amount });
    expect(verify(build([pay(transfer!.amount)]), exp)).not.toThrow();
    const above = formatStroops(BigInt(Math.round(Number(transfer!.amount) * 1e7)) + BigInt(1));
    expect(refusal(verify(build([pay(above)]), exp))).toBe("transfer_above_recorded");
  });
});

describe("the session record", () => {
  test("is required for an exchange selection, refused for any other, and must name the stand-in", () => {
    const code = (over: Partial<PlaygroundSession>) =>
      refusal(() => expectationFromSession(exchangeSession(over), sink, persistentIssuer, null));
    expect(code({ exchange: null })).toBe("session_exchange_missing");
    expect(code({ selection: { scenarios: [{ id: "data-entries", params: {} }] } })).toBe(
      "session_exchange_unexpected"
    );
    expect(
      code({
        exchange: { destination: Keypair.random().publicKey(), memo: MEMO, memoType: "id" },
      })
    ).toBe("session_exchange_not_stand_in");
  });

  test("the plan and the close never acknowledge the stand-in as an account the session controls", () => {
    const exp = expected();
    expect(planAnswers(exp)).toEqual([]);
    expect(buildDemolishDecisions([], exp).answers).toEqual([]);
    const direct = expectationFromSession(
      { ...newSessionData(), selection: { scenarios: [{ id: "data-entries", params: {} }] } },
      sink,
      persistentIssuer,
      null
    );
    expect(planAnswers(direct)).toEqual([
      { id: `destination:${sink}`, choice: "i_control_this_address" },
    ]);
  });

  test("the memo is a nonzero uint64 from fresh randomness, written as an id memo is", () => {
    expect(newExchangeMemo(() => Buffer.alloc(8, 0xff))).toBe("18446744073709551615");
    const draws = [Buffer.alloc(8, 0), Buffer.from("0000000000000007", "hex")];
    expect(newExchangeMemo(() => draws.shift()!)).toBe("7");
    const memos = new Set(Array.from({ length: 50 }, () => newExchangeMemo()));
    expect(memos.size).toBe(50);
    for (const memo of memos) expect(memo).toMatch(/^[1-9][0-9]{0,19}$/);
  });
});

describe("the co-signed envelope", () => {
  beforeEach(() => setSystemTime(new Date(NOW * 1000)));
  afterEach(() => setSystemTime());

  function signed(): Transaction {
    const tx = TransactionBuilder.fromXdr(handOff().xdr, PASSPHRASE) as Transaction;
    tx.sign(demo);
    return tx;
  }
  const xdrOf = (tx: Transaction | FeeBumpTransaction): string => tx.toEnvelope().toXdr("base64");
  const code = (cosigned: string, original = xdrOf(signed())) =>
    refusal(() => assertCosignedEnvelope(original, cosigned, relay.publicKey()));

  test("is accepted with exactly the mediator's signature added", () => {
    const original = signed();
    const cosigned = TransactionBuilder.fromXdr(xdrOf(original), PASSPHRASE) as Transaction;
    cosigned.sign(relay);
    expect(() =>
      assertCosignedEnvelope(xdrOf(original), xdrOf(cosigned), relay.publicKey())
    ).not.toThrow();
  });

  test("a changed transaction is refused, even signed by the demo and the mediator", () => {
    const other = TransactionBuilder.fromXdr(
      handOff(forward({ amount: "29.9999700" })).xdr,
      PASSPHRASE
    ) as Transaction;
    other.sign(demo);
    other.sign(relay);
    expect(code(xdrOf(other))).toBe("exchange_cosign_hash_changed");
  });

  test("a dropped signature is refused", () => {
    const stripped = signed();
    stripped.signatures.splice(0);
    stripped.sign(relay);
    expect(code(xdrOf(stripped))).toBe("exchange_cosign_signature_count");
    // The demo's replaced by another of the same count.
    const replaced = signed();
    replaced.signatures.splice(0);
    replaced.sign(Keypair.random());
    replaced.sign(relay);
    expect(code(xdrOf(replaced))).toBe("exchange_cosign_signature_dropped");
  });

  test("a signature not by the configured mediator is refused", () => {
    const other = signed();
    other.sign(Keypair.random());
    expect(code(xdrOf(other))).toBe("exchange_cosign_not_mediator");
  });

  test("more than one signature added, nothing added, or no transaction at all is refused", () => {
    const two = signed();
    two.sign(relay);
    two.sign(Keypair.random());
    expect(code(xdrOf(two))).toBe("exchange_cosign_signature_count");
    expect(code(xdrOf(signed()))).toBe("exchange_cosign_signature_count");
    expect(code("not xdr")).toBe("exchange_cosign_unreadable");
    const wrapped = TransactionBuilder.buildFeeBumpTransaction(relay, "200", signed(), PASSPHRASE);
    wrapped.sign(relay);
    expect(code(xdrOf(wrapped))).toBe("exchange_cosign_not_transaction");
  });
});

describe("the ledger read-back", () => {
  beforeEach(() => setSystemTime(new Date(NOW * 1000)));
  afterEach(() => setSystemTime());

  const exchange = () => expected().exchange!;
  const code = (envelopeXdr: string, successful = true) =>
    refusal(() =>
      assertDeliveredOnLedger({ successful, envelopeXdr }, demo.publicKey(), exchange())
    );

  test("accepts the relay paying the stand-in at least the floor, with the session's id memo", () => {
    expect(() =>
      assertDeliveredOnLedger(
        { successful: true, envelopeXdr: handOff().xdr },
        demo.publicKey(),
        exchange()
      )
    ).not.toThrow();
  });

  test("a payment carrying another memo is refused, a text memo of the same digits included", () => {
    expect(code(handOff(forward(), Memo.id("124")).xdr)).toBe("exchange_delivery_memo_mismatch");
    expect(code(handOff(forward(), Memo.text(MEMO)).xdr)).toBe("exchange_delivery_memo_mismatch");
    expect(code(handOff(forward(), Memo.none()).xdr)).toBe("exchange_delivery_memo_mismatch");
  });

  test("no payment from the relay to the stand-in at or above the floor is refused", () => {
    expect(code(handOff(forward({ amount: "1.0000000" })).xdr)).toBe(
      "exchange_delivery_payment_missing"
    );
    expect(code(handOff(forward({ to: Keypair.random().publicKey() })).xdr)).toBe(
      "exchange_delivery_payment_missing"
    );
    expect(code(handOff(forward({ from: Keypair.random().publicKey() })).xdr)).toBe(
      "exchange_delivery_payment_missing"
    );
    expect(code(handOff(forward({ asset: new Asset("LWDEMO", persistentIssuer) })).xdr)).toBe(
      "exchange_delivery_payment_missing"
    );
  });

  test("a transaction that failed, or cannot be read, is refused", () => {
    expect(code(handOff().xdr, false)).toBe("exchange_delivery_failed");
    expect(code("not xdr")).toBe("exchange_delivery_unreadable");
  });
});

describe("an exchange close end to end", () => {
  beforeEach(() => setSystemTime(new Date(NOW * 1000)));
  afterEach(() => setSystemTime());
  const noSleep = async (): Promise<void> => {};

  async function newSession(store: SessionStore): Promise<PlaygroundSession> {
    return store.createSession(
      exchangeSession({
        selection: {
          scenarios: [
            { id: "data-entries", params: { count: 1 } },
            { id: "exchange-close", params: {} },
          ],
        },
      })
    );
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
    api: FakeExchangeApi,
    mediatorKey: string | null = relay.publicKey(),
    demoKeypair: Keypair = demo
  ) {
    return runDemolishRound(store, id, {
      round: (session, hooks) =>
        runCloseRound(
          api,
          api,
          {
            demoKeypair,
            signingKeys: [],
            expected: expectationFromSession(session, sink, persistentIssuer, null),
            mediatorKey,
            apiUrl: "unused",
            apiKey: "unused",
            hooks,
          },
          noSleep
        ),
    });
  }

  test("cleans up, hands off through the relay with the memo, and reads the payment back", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeExchangeApi(demo, relay, STAND_IN);

    const first = await round(store, session.id, api);
    expect(first.status).toBe(200);
    expect(first.body.done).toBe(false);
    const second = await round(store, session.id, api);
    expect(second.status).toBe(200);
    expect(second.body.done).toBe(true);

    // Every request names the stand-in and the session's memo, and acknowledges nothing.
    for (const body of api.requests) {
      expect(body).toMatchObject({ destination: STAND_IN, memo: MEMO, memoType: "id" });
      expect(body.decisions?.some((d) => d.id.startsWith("destination:"))).toBe(false);
    }
    // Only the hand-off went to the mediator; what was sent is its co-signed envelope.
    expect(api.signRequests).toHaveLength(1);
    const sent = TransactionBuilder.fromXdr(api.submitted[1]!, PASSPHRASE) as Transaction;
    expect(sent.signatures).toHaveLength(2);
    expect(sent.memo.type).toBe("id");
    const loaded = await store.loadSession(session.id);
    expect(loaded?.demolishDone).toBe(true);
    expect(api.ledgerReads).toEqual([loaded!.demolishLog[1]!.hash]);
  });

  test("the floor is the balance the playground read, never the API's figure", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeExchangeApi(demo, relay, STAND_IN, {
      dataEntries: 0,
      balance: "20.0000000",
    });
    // The API believes the demo holds more, and builds a forward of that.
    api.apiBalance = BigInt(300_000_000);
    const signer = countingDemo();

    const result = await round(store, session.id, api, relay.publicKey(), signer.keypair);
    expect(result).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect(signer.signatures()).toBe(0);
    expect(api.signRequests).toEqual([]);
    expect(api.submitted).toEqual([]);
  });

  test("an envelope the mediator tampered with is never submitted", async () => {
    for (const cosign of [
      "change-hash",
      "drop-signature",
      "other-key",
      "two-signatures",
    ] as const) {
      const store = memoryStore();
      const session = await newSession(store);
      const api = new FakeExchangeApi(demo, relay, STAND_IN, { dataEntries: 0 });
      api.cosign = cosign;

      const result = await round(store, session.id, api);
      expect({ cosign, result }).toEqual({
        cosign,
        result: { status: 502, body: { error: "demolish_failed" } },
      });
      expect(api.signRequests).toHaveLength(1);
      expect(api.submitted).toEqual([]);
      expect((await store.loadSession(session.id))?.demolishPending).toBeNull();
    }
  });

  test("without a configured mediator key the demo key signs no hand-off", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeExchangeApi(demo, relay, STAND_IN, { dataEntries: 0 });
    const signer = countingDemo();

    const result = await round(store, session.id, api, null, signer.keypair);
    expect(result).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect(signer.signatures()).toBe(0);
    expect(api.signRequests).toEqual([]);
  });

  test("a ledger record without the session's memo or the payment is reported, after the merge", async () => {
    for (const ledger of ["wrong-memo", "text-memo", "short", "failed"] as const) {
      const store = memoryStore();
      const session = await newSession(store);
      const api = new FakeExchangeApi(demo, relay, STAND_IN, { dataEntries: 0 });
      api.ledger = ledger;

      const result = await round(store, session.id, api);
      expect({ ledger, result }).toEqual({
        ledger,
        result: { status: 502, body: { error: "demolish_delivery_unconfirmed" } },
      });
      // The merge itself confirmed and is recorded as such.
      expect((await store.loadSession(session.id))?.demolishDone).toBe(true);
    }
  });

  test("a ledger that trails the confirmation is read again, and one that never shows it is reported", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeExchangeApi(demo, relay, STAND_IN, { dataEntries: 0 });
    api.lagReads = 3;
    expect((await round(store, session.id, api)).body.done).toBe(true);
    expect(api.ledgerReads).toHaveLength(4);

    const later = memoryStore();
    const other = await newSession(later);
    const never = new FakeExchangeApi(demo, relay, STAND_IN, { dataEntries: 0 });
    never.lagReads = 100;
    expect(await round(later, other.id, never)).toEqual({
      status: 502,
      body: { error: "demolish_delivery_unconfirmed" },
    });
  });

  test("a hand-off whose outcome was lost is settled by its hash and read back at its own round's balance", async () => {
    const store = memoryStore();
    const session = await newSession(store);
    const api = new FakeExchangeApi(demo, relay, STAND_IN, { dataEntries: 0 });
    api.landSilently = true;
    api.lookupSeesLanded = false;
    const lost = await round(store, session.id, api);
    expect(lost).toEqual({ status: 502, body: { error: "demolish_outcome_unknown" } });
    const pending = (await store.loadSession(session.id))?.demolishPending;
    expect(pending?.closesAccount).toBe(true);
    expect(pending?.recordedBalance).toBe("30.0000000");

    // The balance is gone with the merge: only the record kept the one the forward was held to.
    api.lookupSeesLanded = true;
    const resumed = await round(store, session.id, api);
    expect(resumed.body.done).toBe(true);
    expect(api.requests).toHaveLength(1);
    expect(api.ledgerReads).toEqual([pending!.hash]);
  });
});

describe("creating an exchange session", () => {
  const ORIGIN = "http://localhost:3002";
  const issuer = Keypair.random();
  const mm = Keypair.random();
  const CRON_SECRET = randomBytes(16).toString("hex");

  async function create(selection: ScenarioSelection, store = memoryStore()) {
    const order: string[] = [];
    const res = await handleCreateSession(
      new NextRequest(new URL("/api/session", ORIGIN), {
        method: "POST",
        body: JSON.stringify({ selection }),
      }),
      {
        store,
        rateLimit: async () => null,
        issuer: () => issuer,
        mm: () => mm,
        cronSecret: () => CRON_SECRET,
        marketMakerBalance: async () => ({ balance: "10000.0000000", sellingLiabilities: "0" }),
        ensureExchangeAccount: async (source, address) => {
          expect(source.publicKey()).toBe(mm.publicKey());
          order.push(`ensure:${address}`);
        },
        provisionDemo: async () => {
          order.push("provision");
        },
        encrypt: (plaintext) => Buffer.from(plaintext).toString("base64"),
        unavailable: async () => new Map(),
      }
    );
    return { res, order, store };
  }

  test("records the stand-in and a fresh memo, and makes sure the stand-in exists before the demo is funded", async () => {
    const { res, order, store } = await create(SELECTION);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      accounts: { exchange: PlaygroundSession["exchange"] };
    };
    const session = await store.loadSession(body.sessionId);
    expect(session?.exchange).toEqual({
      destination: STAND_IN,
      memo: expect.stringMatching(/^[1-9][0-9]*$/),
      memoType: "id",
    });
    expect(body.accounts.exchange).toEqual(session!.exchange);
    expect(order).toEqual([`ensure:${STAND_IN}`, "provision"]);

    const again = await create(SELECTION);
    const other = (await again.res.json()) as { accounts: { exchange: { memo: string } } };
    expect(other.accounts.exchange.memo).not.toBe(session!.exchange!.memo);
  });

  test("a session that does not close to the exchange records none and never touches the stand-in", async () => {
    const { res, order } = await create({ scenarios: [{ id: "data-entries", params: {} }] });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { accounts: { exchange: unknown } }).accounts.exchange
    ).toBeNull();
    expect(order).toEqual(["provision"]);
  });

  test("the market maker creates the stand-in only when the network does not have it", async () => {
    const created: string[] = [];
    const deps = (exists: boolean) => ({
      exists: async () => exists,
      create: async (source: Keypair, destination: string, startingBalance: string) => {
        created.push(`${source.publicKey()}:${destination}:${startingBalance}`);
      },
    });
    expect(
      await ensureAccountFromMarketMaker(mm, STAND_IN, EXCHANGE_STAND_IN_FUNDING_XLM, deps(true))
    ).toBe("exists");
    expect(created).toEqual([]);
    expect(
      await ensureAccountFromMarketMaker(mm, STAND_IN, EXCHANGE_STAND_IN_FUNDING_XLM, deps(false))
    ).toBe("created");
    expect(created).toEqual([`${mm.publicKey()}:${STAND_IN}:1`]);
  });
});
