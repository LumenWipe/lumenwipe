import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Account, Address, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type {
  AccountSigner,
  AccountState,
  AccountThresholds,
  BlendSupplyPosition,
  Trustline,
} from "@lumenwipe/types";
import * as rpcModule from "@/lib/stellar/rpc";
import * as pathFinding from "@/lib/stellar/path-finding";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { buildPlan, normalizesSignersFirst } from "@/lib/stellar/tx-builder";
import { toExecutionBreakdown } from "@/lib/close-api/plan-response";
import { ALL_ON } from "@/config/kill-switches";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const SOURCE = Keypair.random().publicKey();
const COSIGNER_B = Keypair.random().publicKey();
const COSIGNER_C = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const EURC = `EURC:${ISSUER}`;
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const POOL_ASSET = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
const TOKEN = Address.contract(Buffer.alloc(32, 5)).toString();

const key = (k: string, weight: number): AccountSigner => ({
  key: k,
  weight,
  type: "ed25519_public_key",
});

const TWO_OF_THREE = {
  signers: [key(SOURCE, 1), key(COSIGNER_B, 1), key(COSIGNER_C, 1)],
  thresholds: { low: 1, med: 2, high: 2 },
};

function trustline(asset: string, balance: string): Trustline {
  const [code, issuer] = asset.split(":");
  return { asset, balance, ...authorizationOf(true), issuer: issuer!, code: code!, limit: "1000" };
}

const position: BlendSupplyPosition = {
  protocol: "blend",
  positionType: "supply",
  contractAddress: POOL,
  assetAddress: POOL_ASSET,
  bTokenAmount: "1",
  usdValue: "25.00",
};

function makeState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "500.0000000",
    dataEntries: [],
    signers: [key(SOURCE, 1)],
    thresholds: { low: 0, med: 1, high: 1 },
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

/** A 2-of-3 account holding a DeFi exit, a Soroban token to transfer, a classic asset to convert
 *  and a claimable balance: every kind of round that used to run before normalization. */
function multisigEverything(over: Partial<AccountState> = {}): AccountState {
  return makeState({
    ...TWO_OF_THREE,
    trustlines: [trustline(USDC, "40.0000000")],
    numSubEntries: 4,
    defiPositions: { ...emptyDefiPositionsResult(SOURCE), positions: [position] },
    sorobanTokens: {
      tokens: [
        { contract: TOKEN, balance: "10", symbol: "XTAR", decimals: 7, sources: ["explorer"] },
      ],
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
    claimableBalances: [
      {
        id: `00000000${"a".repeat(64)}`,
        asset: "native",
        amount: "10.0000000",
        claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
        sponsor: null,
      },
    ],
    ...over,
  });
}

const reached: string[] = [];
const sentinel = (name: string) => (): never => {
  reached.push(name);
  throw new Error(`${name} reached`);
};

function stubRpc(): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: sentinel("claim"),
    simulateTransaction: sentinel("rpc simulation"),
  })) as unknown as typeof rpcModule.getRpcServer);
  spyOn(pathFinding, "fetchConversionPath").mockImplementation(sentinel("classic conversion"));
}

async function build(state: AccountState) {
  return buildCloseTransactions(
    ALL_ON,
    state,
    DEST,
    { [TOKEN]: "transfer", [USDC]: "convert" },
    "testnet",
    "memo-1",
    {},
    { [TOKEN]: Keypair.random().publicKey() },
    { runExitAdapter: sentinel("exit") },
    { rpc: { simulateTransaction: sentinel("token transfer") } }
  );
}

beforeEach(() => {
  reached.length = 0;
  stubIssuance();
  stubLedgerConfirmation();
  stubLedgerConfirmation();
});

afterEach(() => mock.restore());

describe("normalizesSignersFirst", () => {
  const cases: [string, AccountSigner[], AccountThresholds, boolean][] = [
    ["2-of-2", [key(SOURCE, 1), key(COSIGNER_B, 1)], { low: 0, med: 2, high: 2 }, true],
    ["2-of-3", TWO_OF_THREE.signers, TWO_OF_THREE.thresholds, true],
    [
      "a medium threshold above the high one that no single key reaches",
      [key(SOURCE, 2), key(COSIGNER_B, 1)],
      { low: 0, med: 3, high: 2 },
      true,
    ],
    [
      "a low threshold above the others that no single key reaches",
      [key(SOURCE, 1), key(COSIGNER_B, 1)],
      { low: 2, med: 1, high: 1 },
      true,
    ],
    [
      "a hash(x) signer, which is not a key",
      [key(SOURCE, 1), { key: "X".padEnd(56, "A"), weight: 2, type: "hash_x" }],
      { low: 0, med: 1, high: 2 },
      true,
    ],
    [
      "a master key that reaches every threshold alone",
      [key(SOURCE, 2), key(COSIGNER_B, 1)],
      { low: 0, med: 2, high: 2 },
      false,
    ],
    [
      "a co-signer that reaches every threshold alone",
      [key(SOURCE, 1), key(COSIGNER_B, 3)],
      { low: 0, med: 2, high: 2 },
      false,
    ],
    [
      "a weight-0 master key",
      [key(SOURCE, 0), key(COSIGNER_B, 1), key(COSIGNER_C, 1)],
      { low: 0, med: 2, high: 2 },
      false,
    ],
    [
      "an extra signer the master outweighs",
      [key(SOURCE, 1), key(COSIGNER_B, 1)],
      { low: 0, med: 1, high: 1 },
      false,
    ],
    ["no normalization at all", [key(SOURCE, 1)], { low: 0, med: 1, high: 1 }, false],
  ];
  for (const [name, signers, thresholds, expected] of cases) {
    test(`${name}: ${expected}`, () => {
      expect(normalizesSignersFirst(makeState({ signers, thresholds }))).toBe(expected);
    });
  }
});

describe("a multisig close with an exit, a token, a conversion and a claim", () => {
  test("its first transaction removes the other signers and resets the thresholds, and nothing else", async () => {
    stubRpc();
    const result = await build(multisigEverything());

    expect(reached).toEqual([]);
    expect(result.requiresAnotherCall).toBe(true);
    expect(result.transactions).toHaveLength(1);
    const [tx] = result.transactions;
    expect(tx!.covers).toEqual(["NORMALIZE_SIGNERS"]);
    expect(tx!.intent.summary).toBe(
      "Remove 2 other signers and reset the thresholds, so the master key alone signs the rest of the close. This does not close the account."
    );
    const parsed = TransactionBuilder.fromXDR(tx!.xdr, Networks.TESTNET);
    expect("memo" in parsed && parsed.memo.type).toBe("none");
    const ops = parsed.operations.map((op) =>
      op.type === "setOptions"
        ? {
            type: op.type,
            source: op.source ?? null,
            signer: op.signer ?? null,
            thresholds: [op.lowThreshold, op.medThreshold, op.highThreshold],
            masterWeight: op.masterWeight,
          }
        : { type: op.type }
    );
    expect(ops).toEqual([
      {
        type: "setOptions",
        source: null,
        signer: { ed25519PublicKey: COSIGNER_B, weight: 0 },
        thresholds: [undefined, undefined, undefined],
        masterWeight: undefined,
      },
      {
        type: "setOptions",
        source: null,
        signer: { ed25519PublicKey: COSIGNER_C, weight: 0 },
        thresholds: [undefined, undefined, undefined],
        masterWeight: undefined,
      },
      {
        type: "setOptions",
        source: null,
        signer: null,
        thresholds: [0, 1, 1],
        masterWeight: undefined,
      },
    ]);
  });

  test("once normalization lands, the exit is the next round and the account needs only the master key", async () => {
    stubRpc();
    const normalized = multisigEverything({
      signers: [key(SOURCE, 1)],
      thresholds: { low: 0, med: 1, high: 1 },
    });
    expect(normalizesSignersFirst(normalized)).toBe(false);
    await expect(build(normalized)).rejects.toThrow("exit reached");
    expect(reached).toEqual(["exit"]);
  });

  test("the plan reads in the order the builder emits", () => {
    const state = multisigEverything();
    const { steps } = buildPlan(
      ALL_ON,
      state,
      false,
      true,
      {},
      undefined,
      { [TOKEN]: "transfer", [USDC]: "convert" },
      {},
      state.defiPositions
    );
    expect(steps.map((s) => s.type)).toEqual([
      "NORMALIZE_SIGNERS",
      "EXIT_POSITIONS",
      "HANDLE_ASSETS",
      "CLAIM_BALANCES",
      "HANDLE_ASSETS",
      "REMOVE_TRUSTLINES",
      "MERGE",
    ]);
    expect(steps[0]!.description).toBe(
      "Remove 2 additional signer(s) and reset authorization thresholds, in a transaction of its own before every other step. It leaves this key as the account's only signer, and it does not close the account: if a later step of the close is refused, the account stays open under this key alone."
    );
  });
});

describe("round 0 is refused while a later round is already known to be", () => {
  test("a fee budget the Soroban rounds cannot meet", async () => {
    stubRpc();
    const promise = build(multisigEverything({ nativeBalanceLumens: "3.0200000" }));
    await expect(promise).rejects.toMatchObject({ code: "close_fee_balance_short", status: 422 });
    expect(reached).toEqual([]);
  });

  test("a claim whose new trustline the reserve cannot cover", async () => {
    stubRpc();
    const promise = buildCloseTransactions(
      ALL_ON,
      makeState({
        ...TWO_OF_THREE,
        nativeBalanceLumens: "1.0000000",
        claimableBalances: [
          {
            id: `00000000${"b".repeat(64)}`,
            asset: EURC,
            amount: "5.0000000",
            claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
            sponsor: null,
          },
        ],
      }),
      DEST,
      {},
      "testnet",
      null,
      { [`00000000${"b".repeat(64)}`]: "add_trustline_then_claim" }
    );
    await expect(promise).rejects.toMatchObject({
      code: "claimable_balance_reserve_short",
      status: 422,
    });
    expect(reached).toEqual([]);
  });

  test("a classic balance answered leave", async () => {
    stubRpc();
    const promise = buildCloseTransactions(
      ALL_ON,
      makeState({ ...TWO_OF_THREE, trustlines: [trustline(USDC, "40.0000000")], numSubEntries: 1 }),
      DEST,
      { [USDC]: "leave" },
      "testnet"
    );
    await expect(promise).rejects.toMatchObject({ code: "trustline_cannot_be_left", status: 422 });
  });

  test("a classic balance to transfer with no destination", async () => {
    stubRpc();
    const promise = buildCloseTransactions(
      ALL_ON,
      makeState({ ...TWO_OF_THREE, trustlines: [trustline(USDC, "40.0000000")], numSubEntries: 1 }),
      DEST,
      { [USDC]: "transfer" },
      "testnet"
    );
    await expect(promise).rejects.toThrow(/USDC/);
  });
});

describe("single-key closes are unchanged", () => {
  test("an extra signer the master outweighs still rides in the one close transaction", async () => {
    stubRpc();
    const state = makeState({ signers: [key(SOURCE, 1), key(COSIGNER_B, 1)] });
    const result = await buildCloseTransactions(ALL_ON, state, DEST, {}, "testnet");
    expect(result.requiresAnotherCall).toBe(false);
    expect(result.transactions.map((t) => t.covers)).toEqual([["NORMALIZE_SIGNERS", "MERGE"]]);
  });

  test("the fused close is still offered to one key, and never to a multisig account", () => {
    const single = makeState({ signers: [key(SOURCE, 1), key(COSIGNER_B, 1)] });
    expect(buildPlan(ALL_ON, single, false, true).steps.map((s) => s.type)).toEqual([
      "CLOSE_ACCOUNT",
    ]);
    const multisig = makeState(TWO_OF_THREE);
    const { steps } = buildPlan(ALL_ON, multisig, false, true);
    expect(steps.map((s) => s.type)).toEqual(["NORMALIZE_SIGNERS", "MERGE"]);
    expect(
      toExecutionBreakdown(steps, { viaMediator: false, decided: true, normalizationFirst: true })
        .transactions
    ).toEqual([
      { order: 0, covers: ["NORMALIZE_SIGNERS"] },
      { order: 1, covers: ["MERGE"] },
    ]);
  });
});
