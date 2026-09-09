import type { DefiPosition, DefiProtocol, Network, PlanBlocker } from "@lumenwipe/types";
import type { Transaction, rpc, xdr } from "@stellar/stellar-sdk";
import type { ContractKind } from "@/lib/contract-registry";
import type { HealthInputs } from "./invariants";

/**
 * The contract every protocol exit adapter implements (architecture.md §9.9), split so the parts
 * that touch the network are injectable and the parts that decide and build are pure:
 *
 *   readLive  -> fresh amounts, debt, health from RPC, immediately before anything is built,
 *                for the code version the registry resolved (it decides which client reads).
 *                The detection result (OctoPos or the testnet fallback) says a position exists;
 *                it never supplies the amount an exit moves.
 *   plan      -> pure: the ordered steps that close the position, or the blockers that stop it,
 *                given the code version the registry resolved for the position's contract.
 *   health    -> pure: the collateral/debt state the plan leaves the position in before any
 *                withdrawal (after its repays), or null for a position with no debt concept.
 *   buildStep -> pure: one step to one contract invocation - built locally as an operation, or
 *                obtained from an external builder as a whole envelope - plus a description of
 *                what it does, in the vocabulary a client-side verifier can check against.
 *
 * `runExitAdapter` (run-exit.ts) drives these in a fixed order and enforces, from outside the
 * adapter, the invariants no adapter is trusted to remember on its own: the registry must be
 * fresh and must know the live wasmHash of every contract the plan touches before anything is
 * read or built; every amount stays within the live balance; every price-dependent step carries
 * a positive minimum-received floor; a position with debt repays before it withdraws and stays
 * above its liquidation threshold; the intent must describe the bytes it travels with; the step
 * is simulated (and, when built locally, assembled from that simulation) before it is offered;
 * and a position that yields neither steps nor blockers is itself a blocker.
 *
 * Only the first step of a plan is built per run: a Soroban invocation cannot share a
 * transaction with classic operations, and simulation runs against the current ledger, so a
 * later step (a withdraw after a repay) can only be simulated once the earlier one has confirmed.
 * The close loop is already multi-round and re-reads live state each round, so the rest of the
 * plan is re-planned fresh rather than pre-built stale.
 */

export type ExitStepKind =
  /** Pay down debt. */
  | "repay"
  /** Take a lending supply back out; no price involved. */
  | "withdraw"
  /** Take collateral out of a lending or CDP position; no price involved. */
  | "withdraw_collateral"
  /** Burn LP shares for the underlying assets; price-dependent, needs floors. */
  | "lp_withdraw"
  /** Trade one asset for another; price-dependent, needs a floor. */
  | "swap"
  /** Collect rewards or emissions. */
  | "claim"
  /** Unbond staked tokens. */
  | "unstake"
  /** Queue a withdrawal that a cooldown will later allow. */
  | "queue_withdrawal";

/** Kinds whose proceeds depend on a price or a route, so they must carry fresh-quote floors. */
export const MIN_RECEIVED_REQUIRED: readonly ExitStepKind[] = ["lp_withdraw", "swap"];

/** Kinds that take value out of the position; each must follow every `repay` in the plan. */
export const WITHDRAWAL_KINDS: readonly ExitStepKind[] = [
  "withdraw",
  "withdraw_collateral",
  "lp_withdraw",
  "unstake",
];

/** Amounts are base units of the asset (the i128 the contract sees), as decimal integer strings. */
export interface MinReceived {
  asset: string;
  amount: string;
}

export interface ExitStep {
  kind: ExitStepKind;
  /** The contract this step invokes. Every distinct contract in a plan is registry-checked. */
  contract: string;
  function: string;
  /** The token this step moves, by contract address. */
  asset: string;
  /** What this step moves, in base units. */
  amount: string;
  /** The live balance this step draws on, in base units - from readLive, never detection. */
  ceiling: string;
  /** True when the contract itself clamps the request to the position (a Blend withdraw), so the
   *  step may over-ask by a small, bounded margin to cover interest accrued between the read and
   *  the ledger and leave no dust. The runner bounds that margin; without this flag an amount
   *  above the ceiling is refused outright. */
  clampsToPosition?: boolean;
  /** One floor per asset received. Empty for kinds with no price exposure. */
  minReceived: MinReceived[];
  /** Plain-language line for the plan review screen. */
  description: string;
}

export interface ExitPlan {
  steps: ExitStep[];
  blockers: PlanBlocker[];
}

/**
 * The one blocker code with a meaning the round builder acts on: the position detection reported
 * no longer exists on the ledger (typically exited on an earlier round, with detection lagging a
 * snapshot). A round treats it as "nothing left here" and moves on; every other blocker refuses
 * the build. Adapters must use exactly this code for that case.
 */
export const EXIT_POSITION_GONE = "exit_position_gone";

/** The registry's verdict on the position's contract, so the adapter encodes for the right ABI. */
export interface ContractVersion {
  version: string;
  kind: ContractKind;
}

/**
 * What the adapter claims its invocation does. The runner decodes the built bytes and checks the
 * claim against them (contract, function, source) and against the step (floors, recipient), so
 * an intent can describe but never misdescribe what the user is asked to sign. `args` are the
 * decoded arguments rendered for a human.
 */
export interface ExitIntent {
  contract: string;
  function: string;
  args: string[];
  minReceived: MinReceived[];
  /** Who receives the exit's proceeds - always the account being closed. */
  recipient: string;
}

/**
 * How the step's bytes were produced. `local` is an operation this adapter assembled; `external`
 * is a whole envelope an outside builder returned (the Soroswap API), kept byte-for-byte and
 * verified rather than trusted (§9.9 "verify server-built XDR").
 */
export type ExitBuild =
  | { source: "local"; op: xdr.Operation }
  | { source: "external"; provider: string; envelopeXdr: string };

export interface BuiltExitStep {
  step: ExitStep;
  build: ExitBuild;
  intent: ExitIntent;
}

export interface ExitContext {
  network: Network;
  /** The account being closed: source of every operation and recipient of every exit. */
  account: string;
  /** Its current sequence number, for the simulation envelope. */
  sequence: string;
  /** What the account holds of each token, keyed by contract address, in base units - what a
   *  repay can spend. Native XLM and classic assets appear under their Stellar Asset Contract. */
  tokenBalances: Record<string, string>;
  now: Date;
  slippageBps: number;
}

/** The two RPC calls an exit needs, so tests and the runner can pass a stub instead of a server. */
export type ExitRpc = Pick<rpc.Server, "getLedgerEntries" | "simulateTransaction">;

export interface ExitAdapter<P extends DefiPosition, L> {
  protocol: DefiProtocol;
  supports(position: DefiPosition): position is P;
  readLive(position: P, code: ContractVersion, ctx: ExitContext, rpc: ExitRpc): Promise<L>;
  plan(position: P, live: L, code: ContractVersion, ctx: ExitContext): ExitPlan;
  health(position: P, live: L, steps: ExitStep[]): HealthInputs | null;
  buildStep(step: ExitStep, live: L, ctx: ExitContext): BuiltExitStep;
  /**
   * Optional: adjust the assembled, simulated transaction before it is offered - for a protocol
   * whose execution is known to diverge from its simulation (a footprint the contract will write
   * to at execution but only read in simulation). Must not change the operation itself: the runner
   * re-checks the invocation, the authorization tree, and the fee cap after this hook.
   */
  hardenBuilt?(tx: Transaction, step: ExitStep, live: L, ctx: ExitContext): Transaction;
}
