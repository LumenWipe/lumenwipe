import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountSigner, AccountState, StepType } from "@lumenwipe/types";
import * as rpcModule from "@/lib/stellar/rpc";
import * as registry from "@/lib/exchange-registry";
import * as networks from "@/config/networks";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { ALL_ON } from "@/config/kill-switches";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { ledgerRpcServer, mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const SOURCE = Keypair.random().publicKey();
const COSIGNER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const key = (k: string, weight: number): AccountSigner => ({
  key: k,
  weight,
  type: "ed25519_public_key",
});

interface Shape {
  signersFirst: boolean;
  claims: boolean;
  data: boolean;
  mediator: boolean;
}

function stateOf({ signersFirst, claims, data }: Shape): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "500.0000000",
    dataEntries: data ? [{ key: "note", value: "aGk=" }] : [],
    // Signers first when no single key reaches every threshold; otherwise the master key does,
    // and the signer removal rides in the close.
    signers: signersFirst ? [key(SOURCE, 1), key(COSIGNER, 1)] : [key(SOURCE, 2), key(COSIGNER, 1)],
    thresholds: signersFirst ? { low: 1, med: 2, high: 2 } : { low: 0, med: 1, high: 2 },
    numSubEntries: 1 + (data ? 1 : 0),
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: claims
      ? [
          {
            id: `00000000${"c".repeat(64)}`,
            asset: "native",
            amount: "10.0000000",
            claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
            sponsor: null,
          },
        ]
      : [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

/** The account once a round's transactions confirm, as the next call reads it. */
function afterRound(state: AccountState, covers: readonly StepType[]): AccountState {
  const next = { ...state };
  if (covers.includes("NORMALIZE_SIGNERS")) {
    next.signers = [key(SOURCE, 1)];
    next.thresholds = { low: 0, med: 1, high: 1 };
  }
  if (covers.includes("CLAIM_BALANCES")) {
    next.claimableBalances = [];
    next.nativeBalanceLumens = "510.0000000";
  }
  if (covers.includes("REMOVE_DATA_ENTRIES")) next.dataEntries = [];
  next.numSubEntries = next.dataEntries.length + next.signers.length - 1;
  return next;
}

/** Every transaction the close builds, round by round, each as the step types it covers. */
async function closeTransactions(state: AccountState): Promise<StepType[][]> {
  const built: StepType[][] = [];
  let current = state;
  for (let round = 0; round < 10; round++) {
    const result = await buildCloseTransactions(ALL_ON, current, DEST, {}, "testnet");
    const covers = result.transactions.map((tx) => tx.covers);
    built.push(...covers);
    if (!result.requiresAnotherCall) return built;
    current = afterRound(current, covers.flat());
  }
  throw new Error("the close did not finish in 10 rounds");
}

/** For each plan step in plan order, the first transaction at or after the previous step's that
 *  covers it. -1 when none does from there: a step listed before one that runs earlier. */
function transactionOfEachStep(steps: readonly StepType[], txs: readonly StepType[][]): number[] {
  let at = 0;
  return steps.map((type) => {
    while (at < txs.length && !txs[at]!.includes(type)) at++;
    return at < txs.length ? at : -1;
  });
}

const SHAPES: Shape[] = [];
for (const signersFirst of [true, false])
  for (const claims of [true, false])
    for (const data of [true, false])
      for (const mediator of [true, false]) SHAPES.push({ signersFirst, claims, data, mediator });

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  stubLedgerConfirmation();
  spyOn(rpcModule, "getRpcServer").mockImplementation(() =>
    ledgerRpcServer(
      SOURCE,
      mirrorSnapshot(SOURCE, () => [])
    )
  );
});

afterEach(() => mock.restore());

describe("the plan lists its steps in the order the close builds its transactions", () => {
  test.each(SHAPES)("%o", async (shape) => {
    spyOn(registry, "requiresMediatorForAddress").mockReturnValue(shape.mediator);
    spyOn(networks, "getMediatorPublicKey").mockReturnValue(Keypair.random().publicKey());
    const state = stateOf(shape);
    const plan = buildPlan(ALL_ON, state, shape.mediator);
    expect(plan.blockers).toEqual([]);
    const steps = plan.steps.map((s) => s.type);
    const txs = await closeTransactions(state);

    const placed = transactionOfEachStep(steps, txs);
    expect(placed).not.toContain(-1);
    // Every transaction carries at least one listed step.
    expect(new Set(placed).size).toBe(txs.length);
  });
});
