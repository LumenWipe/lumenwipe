import type { DefiPosition, DefiProtocol, Network, PlanBlocker } from "@lumenwipe/types";
import type { rpc, xdr } from "@stellar/stellar-sdk";

/**
 * The contract every protocol exit adapter implements (architecture.md §9.9), split so the parts
 * that touch the network are injectable and the parts that decide and build are pure:
 *
 *   readLive  -> fresh amounts, debt, health from RPC, immediately before anything is built.
 *                The detection result (OctoPos or the testnet fallback) says a position exists;
 *                it never supplies the amount an exit moves.
 *   plan      -> pure: the ordered steps that close the position, or the blockers that stop it.
 *   buildStep -> pure: one step to one contract invocation, plus a description of what that
 *                invocation does, in the vocabulary a client-side verifier can check against.
 *
 * `runExitAdapter` (run-exit.ts) drives the three in a fixed order and enforces, from outside the
 * adapter, the invariants no adapter is trusted to remember on its own: the live wasmHash must
 * resolve in the registry before readLive is even called, every built amount stays within the
 * live balance, every price-dependent step carries a minimum-received floor, repay precedes
 * withdraw, every step is simulated before it is offered for signing, and a position that yields
 * neither steps nor blockers is itself a blocker.
 *
 * Each step becomes its own transaction: a Soroban InvokeHostFunction cannot share a transaction
 * with classic operations, and simulation is per transaction (fused-close.ts).
 */

export type ExitStepKind =
  | "repay"
  | "withdraw"
  | "withdraw_collateral"
  | "remove_liquidity"
  | "swap"
  | "claim"
  | "unstake"
  | "queue_withdrawal";

/** Kinds whose proceeds depend on a price or a route, so they must carry a fresh-quote floor. */
export const MIN_RECEIVED_REQUIRED: readonly ExitStepKind[] = ["remove_liquidity", "swap"];

/** Kinds that take value out of the position; each must follow every `repay` in the plan. */
export const WITHDRAWAL_KINDS: readonly ExitStepKind[] = [
  "withdraw",
  "withdraw_collateral",
  "remove_liquidity",
  "unstake",
];

/** Amounts are base units of the asset (the i128 the contract sees), as decimal integer strings. */
export interface MinReceived {
  asset: string;
  amount: string;
}

export interface ExitStep {
  kind: ExitStepKind;
  /** The contract this step invokes - normally the position's own pool, pair, or vault. */
  contract: string;
  function: string;
  /** What this step moves, in base units. */
  amount: string;
  /** The live balance `amount` must not exceed, in base units - from readLive, never detection. */
  ceiling: string;
  minReceived: MinReceived | null;
  /** Plain-language line for the plan review screen. */
  description: string;
}

export interface ExitPlan {
  steps: ExitStep[];
  blockers: PlanBlocker[];
}

/**
 * What the adapter claims its operation does. The runner decodes the built operation and checks
 * the claim against it (contract and function), so an intent can describe but never misdescribe
 * the bytes it travels with. `args` are the decoded arguments rendered for a human.
 */
export interface ExitIntent {
  contract: string;
  function: string;
  args: string[];
  minReceived: MinReceived | null;
  /** Who receives the exit's proceeds - always the account being closed. */
  recipient: string;
}

export interface BuiltExitStep {
  step: ExitStep;
  op: xdr.Operation;
  intent: ExitIntent;
}

export interface ExitContext {
  network: Network;
  /** The account being closed: source of every operation and recipient of every exit. */
  account: string;
  /** Its current sequence number, for the simulation envelope. */
  sequence: string;
  now: Date;
  slippageBps: number;
}

/** The two RPC calls an exit needs, so tests and the runner can pass a stub instead of a server. */
export type ExitRpc = Pick<rpc.Server, "getLedgerEntries" | "simulateTransaction">;

export interface ExitAdapter<P extends DefiPosition, L> {
  protocol: DefiProtocol;
  supports(position: DefiPosition): position is P;
  readLive(position: P, ctx: ExitContext, rpc: ExitRpc): Promise<L>;
  plan(position: P, live: L, ctx: ExitContext): ExitPlan;
  buildStep(step: ExitStep, live: L, ctx: ExitContext): BuiltExitStep;
}
