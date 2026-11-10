import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Account, Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import * as networks from "@/config/networks";
import * as pathFinding from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { ALL_ON } from "@/config/kill-switches";
import { defaultExchangeRegistry } from "@/common/ports";
import { lookupExchange } from "@/lib/exchange-registry";
import { MediatorSigningService } from "@/mediator/mediator-signing.service";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

// The transactions this API builds and co-signs for the playground's exchange close, kept as a
// fixture that apps/playground's relay verifier must accept (apps/playground/tests/unit/
// exchange-close.test.ts): a demo holding two data entries closes into the shipped registry's
// testnet stand-in with an id memo. Two rounds: the cleanup, which removes the entries and carries
// neither a merge nor a memo, then, once it lands, the merge into the relay and the relay's
// forward to the stand-in with the memo. The forward is then signed by the demo and co-signed by
// the API's mediator, exactly as the playground sends it. The registry's stand-in entry is kept
// beside them, so the playground's restated copy is pinned to the API's.
//
// Regenerate: UPDATE_PLAYGROUND_RECIPE=1 bun test tests/unit/playground-exchange-recipe.test.ts,
// then bun run format from the repository root.

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../playground/tests/fixtures/api-recipe-exchange.json", import.meta.url)
);
const UPDATE = process.env.UPDATE_PLAYGROUND_RECIPE === "1";

// Fixed, so the envelopes and signatures are byte-identical run to run, and inside the shipped
// registry's verification window, which an exchange close is checked against. Every key is
// derived from a fixed seed at runtime, for this fixture only.
const BUILT_AT_SECONDS = 1_793_000_000;
const pair = (n: number): Keypair => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const DEMO = pair(41);
const SINK = pair(42).publicKey();
const LWDEMO_ISSUER = pair(43).publicKey();
const RELAY = pair(44);
const STAND_IN = "GB4VXLVR2DDIJUPVVY74QVPEIHINBMMXO6WUY67JUEYO42LQSDS5IMKW";
const MEMO = "9007199254740993";
const DATA_KEYS = ["promo_code", "legacy_app_state"];
const BEFORE_CLEANUP = "30.0000000";
/** What is left once the cleanup's two-operation fee is paid. */
const AFTER_CLEANUP = "29.9999800";

function accountState(over: Partial<AccountState>): AccountState {
  return {
    address: DEMO.publicKey(),
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: BEFORE_CLEANUP,
    dataEntries: [],
    signers: [{ key: DEMO.publicKey(), weight: 1, type: "ed25519_public_key" }],
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
    defiPositions: emptyDefiPositionsResult(DEMO.publicKey()),
    defiPositionsWarnings: [],
    ...over,
  };
}

function stubLedger(state: AccountState): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(DEMO.publicKey(), state.sequence)),
    getLatestLedger: () => Promise.resolve({ sequence: 1000, closeTime: String(BUILT_AT_SECONDS) }),
    getLedgerEntries: mirrorSnapshot(DEMO.publicKey(), () => state.trustlines),
  })) as unknown as typeof rpcModule.getRpcServer);
}

const build = (state: AccountState) =>
  buildCloseTransactions(
    ALL_ON,
    state,
    STAND_IN,
    {},
    "testnet",
    MEMO,
    {},
    {},
    {},
    {},
    {},
    false,
    {},
    "id"
  );

/** The API's mediator, holding the relay key, reading the merged demo's balance as it stands. */
function mediator(): MediatorSigningService {
  return new MediatorSigningService(
    { keypair: () => RELAY, configuredPublicKey: () => RELAY.publicKey() },
    defaultExchangeRegistry,
    () => new Date(BUILT_AT_SECONDS * 1000),
    {
      readNativeBalance: async () => ({ nativeBalanceLumens: AFTER_CLEANUP }) as never,
      readMemoRequired: async () => false,
    }
  );
}

async function exchangeRecipe() {
  const before = accountState({
    numSubEntries: DATA_KEYS.length,
    dataEntries: DATA_KEYS.map((k) => ({ key: k, value: "eA==" })),
  });
  stubLedger(before);
  const cleanup = await build(before);
  const after = accountState({ sequence: "101", nativeBalanceLumens: AFTER_CLEANUP });
  stubLedger(after);
  const handOff = await build(after);

  const merge = new Transaction(handOff.transactions[0]!.xdr, Networks.TESTNET);
  merge.sign(DEMO);
  const signed = merge.toEnvelope().toXDR("base64");
  const cosigned = (await mediator().sign("testnet", { transaction: signed })).transaction;
  return {
    name: "exchange",
    selection: {
      scenarios: [
        { id: "data-entries", params: { count: DATA_KEYS.length } },
        { id: "exchange-close", params: {} },
      ],
    },
    session: {
      demoPublic: DEMO.publicKey(),
      sinkPublic: SINK,
      persistentIssuer: LWDEMO_ISSUER,
      exchange: { destination: STAND_IN, memo: MEMO, memoType: "id" },
    },
    relay: RELAY.publicKey(),
    /** The demo's balance before each round, as the playground reads it from the network. */
    balances: [BEFORE_CLEANUP, AFTER_CLEANUP],
    requiresAnotherCall: [cleanup.requiresAnotherCall, handOff.requiresAnotherCall],
    transactions: [...cleanup.transactions, ...handOff.transactions].map((tx) => tx.xdr),
    signed,
    cosigned,
  };
}

beforeEach(() => {
  setSystemTime(new Date(BUILT_AT_SECONDS * 1000));
  stubIssuance();
  stubLedgerConfirmation();
  spyOn(networks, "getMediatorPublicKey").mockReturnValue(RELAY.publicKey());
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(() => {
    throw new Error("the playground's exchange recipe never converts");
  });
});

afterEach(() => {
  mock.restore();
  setSystemTime();
});

test("the exchange recipe builds and co-signs the transactions in apps/playground's fixture", async () => {
  const entry = lookupExchange(STAND_IN, "testnet");
  const fixture = {
    builtAtSeconds: BUILT_AT_SECONDS,
    standIn: entry && {
      address: entry.address,
      name: entry.name,
      requiresMediator: entry.requiresMediator,
      requiresMemo: entry.requiresMemo,
      memoType: entry.memoType,
      network: entry.network ?? null,
    },
    recipes: [await exchangeRecipe()],
  };
  if (UPDATE) writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  expect(existsSync(FIXTURE_PATH)).toBe(true);
  // Compared as data, so `bun run format` may lay the file out as it likes. On a mismatch,
  // regenerate (see the top of this file), format, and run apps/playground's tests.
  expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(fixture);
});

test("the stand-in is the shipped testnet-only entry, routed through the relay with an id memo", () => {
  expect(lookupExchange(STAND_IN, "testnet")).toMatchObject({
    name: "LumenWipe testnet exchange",
    requiresMediator: true,
    requiresMemo: true,
    memoType: "id",
    network: "testnet",
  });
  expect(lookupExchange(STAND_IN, "mainnet")).toBeNull();
});

test("the cleanup carries no merge and no memo; the hand-off is the relay's two operations with the memo", async () => {
  const recipe = await exchangeRecipe();
  expect(recipe.requiresAnotherCall).toEqual([true, false]);
  const [cleanup, handOff] = recipe.transactions.map(
    (xdr) => TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction
  );
  expect(cleanup!.operations.map((op) => op.type)).toEqual(["manageData", "manageData"]);
  expect(cleanup!.memo.type).toBe("none");
  expect(handOff!.operations.map((op) => op.type)).toEqual(["accountMerge", "payment"]);
  expect(handOff!.operations[0]).toMatchObject({ destination: RELAY.publicKey() });
  expect(handOff!.operations[1]).toMatchObject({
    source: RELAY.publicKey(),
    destination: STAND_IN,
  });
  expect(handOff!.memo.type).toBe("id");
  expect(handOff!.memo.value).toBe(MEMO);
  const cosigned = TransactionBuilder.fromXDR(recipe.cosigned, Networks.TESTNET);
  expect(cosigned.signatures).toHaveLength(2);
  expect(Buffer.from(cosigned.hash()).equals(Buffer.from(handOff!.hash()))).toBe(true);
});
