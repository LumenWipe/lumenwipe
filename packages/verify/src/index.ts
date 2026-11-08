/**
 * `@lumenwipe/verify`: the verifier the LumenWipe web app runs before every signature, compiled
 * from the web's own modules rather than copied. There is one implementation; this file only
 * gives it explicit, documented types. `tests/types.test.ts` pins every type below to the web
 * signature in both directions, so a change on either side fails the build.
 *
 * @packageDocumentation
 */
import type { AccountSigner, AccountState, AccountThresholds } from "@lumenwipe/types";
import { verifyCloseTransaction as webVerifyCloseTransaction } from "../../../apps/web/lib/stellar/verify";
import { exitExpectations as webExitExpectations } from "../../../apps/web/lib/stellar/exit-expectations";
import { mediatorAllowedFor } from "../../../apps/web/lib/exchange-registry";

export {
  VerificationError,
  type VerificationErrorCode,
} from "../../../apps/web/lib/stellar/verification-error";
export type { AccountSigner, AccountState, AccountThresholds };

/** The Stellar network a transaction is verified for. Selects the network passphrase the XDR is
 *  decoded with and the bundled registry entries that apply. */
export type Network = "mainnet" | "testnet";

/** A per-asset transfer the user chose: the account the balance goes to and the floor it is
 *  held to. */
export interface TransferChoice {
  /** The account the user typed for this asset. */
  destination: string;
  /** The balance the account read showed, in the asset's display units for a classic asset
   *  (`"12.5000000"`) or base units for a Soroban token. A floor, not an exact figure. */
  amount: string;
}

/** A Soroban token conversion the user chose, with the quote they accepted. */
export interface TokenConversionChoice {
  /** The least XLM, in stroops, the plan quoted and the user accepted. The built swap's own
   *  minimum must be at least this. */
  minAmountOut: string;
  /** The quoted XLM out, in stroops, when the plan reported one. */
  amountOut?: string;
  /** The token balance sold, in base units. */
  amountIn: string;
  /** An xBull route as the API resolved it at plan time. Not relied on: the verifier reads xBull
   *  routes through the bundled asset table. */
  resolvedPath?: string[];
}

/** A classic conversion the user chose. */
export interface ClassicConversionChoice {
  /** The least XLM, in stroops, the plan showed it delivering, or null for an asset only a DeFi
   *  exit pays in (no amount to quote; only the choice and a positive minimum are held). */
  minAmountOut: string | null;
}

/**
 * The DeFi half of the expectation. Build it with {@link exitExpectations} from the account read
 * the user reviewed, never by hand from a plan: it combines that read with the registries bundled
 * in this package. Empty lists fail closed (every exit is refused).
 */
export interface ExitExpectations {
  /** Pools, pairs or vaults the account holds a position in, plus the bundled registry's routers,
   *  backstops and stakes for those protocols. An exit may invoke only one of these. */
  exitContracts: string[];
  /** The Stellar Asset Contract of every asset the account holds (XLM and each trustline) and
   *  the Soroban tokens the read confirmed with a positive balance. */
  heldTokenContracts: string[];
  /** Each position's tokens, share token and debt token: what a withdrawal pays out or spends. */
  positionTokenContracts: string[];
  /** Per exit contract, the functions that leave that protocol. */
  exitFunctions: Record<string, string[]>;
  /** The bundled registry's Soroswap aggregator and router and xBull's router: the only contracts
   *  a token conversion may be entered through. */
  conversionContracts: string[];
  /** XLM's contract on this network: the one asset a token conversion may buy. */
  xlmContract: string;
  /** Every contract the bundled contract registry names on this network. */
  registryContracts: string[];
  /** XLM's contract and the contract of every classic asset the account holds. Only a registry
   *  contract may receive or spend these in an exit. */
  protectedTokenContracts: string[];
  /** xBull's router asset table, index to token contract; empty off mainnet. */
  xbullAssets: Record<string, string>;
  /** Per position contract, the tokens the account read names as that position's own. */
  ownTokensByContract: Record<string, string[]>;
  /** Per Blend pool, the tokens of the account's `borrow` positions in that pool. */
  repayTokensByPool: Record<string, string[]>;
  /** Every position's share token (Aquarius, Phoenix). */
  shareTokenContracts: string[];
  /** Every position's debt token (FxDAO). */
  debtTokenContracts: string[];
}

/**
 * What the integrator independently knows a close transaction should do. Three sources, never
 * the transaction under verification:
 *
 * - the user's own inputs: `destination`, `memo`, `memoType` and every per-asset choice;
 * - the account read the user reviewed (`client.getAccount` or the plan's `sourceAccount`):
 *   `source`, `nativeBalance`, `accountSigners`, `accountThresholds`, and the exit half;
 * - this package's bundled registries, through {@link exitExpectations}.
 *
 * The memo policy for a listed exchange (whether a memo is required, its type, whether the merge
 * must go through the shared intermediary) is not an input: the verifier derives it from the
 * exchange registry bundled in this package.
 */
export interface CloseExpectationInput extends ExitExpectations {
  /** The account being closed. */
  source: string;
  /** The final destination the user typed. */
  destination: string;
  /** The account's native balance in XLM as last read (`"100.0000000"`). The floor under the
   *  intermediary's forward on an exchange close. `"0"` when unknown fails closed. */
  nativeBalance: string;
  /** The memo the user confirmed, or null. */
  memo: string | null;
  /** The type the user confirmed for `memo`, or null with no memo. A listed exchange's registry
   *  type replaces it. */
  memoType: "text" | "id" | "hash" | null;
  /** Canonical `CODE:ISSUER` of each trustline a claimable balance claim may add and remove. */
  claimTrustlineAssets: string[];
  /** The account's signers from the read. A transaction may never add one. Empty fails closed. */
  accountSigners: AccountSigner[];
  /** The account's thresholds from the read. A transaction may never raise one. */
  accountThresholds: AccountThresholds;
  /** The per-asset transfers the user chose, keyed by canonical `CODE:ISSUER`. Required: pass
   *  `{}` to allow none. */
  transfers: Record<string, TransferChoice>;
  /** The Soroban token transfers the user chose, keyed by token contract, amounts in base units. */
  tokenTransfers: Record<string, TransferChoice>;
  /** The classic conversions the user chose, keyed by `CODE:ISSUER`. Only these may be sold. */
  classicConversions: Record<string, ClassicConversionChoice>;
  /** The Soroban token conversions the user chose, keyed by token contract. */
  tokenConversions: Record<string, TokenConversionChoice>;
}

/** The input to {@link verifyCloseTransaction}. */
export interface VerifyCloseInput {
  /** The unsigned transaction envelope as returned by the API (`CloseTransaction.xdr`), base64. */
  unsignedXdr: string;
  /** The network the close runs on. */
  network: Network;
  /** True only for a pre-authorized transaction the account's own signers set up earlier. */
  preAuthorized?: boolean;
  /** What the transaction must do, from the user's inputs and the reviewed account read. */
  expected: CloseExpectationInput;
}

/**
 * Decodes an API-built, unsigned close transaction and asserts it does exactly what `expected`
 * says, using the exchange and contract registries bundled in this package. Returns only when the
 * transaction may be signed; throws {@link VerificationError} on any mismatch.
 *
 * Synchronous and offline: it reads no network and no page state. It reads the system clock
 * twice: for the transaction's expiry (at most 900 seconds ahead) and for the bundled exchange
 * registry's `validUntil`, past which an exchange close is refused until this package is updated.
 * Run it once per transaction, immediately before each signature.
 */
export function verifyCloseTransaction(input: VerifyCloseInput): void {
  webVerifyCloseTransaction(input);
}

/**
 * The DeFi half of a close expectation, derived from the account read the user reviewed and the
 * contract registry bundled in this package. With no read, every list is empty and every exit is
 * refused.
 */
export function exitExpectations(
  accountState: AccountState | null | undefined,
  network: Network
): ExitExpectations {
  return webExitExpectations(accountState, network);
}

/**
 * Whether a close to `address` goes through the shared intermediary: true only for an exchange
 * the registry bundled in this package lists as unable to receive an account merge. The same
 * rule `verifyCloseTransaction` applies, so an integrator decides from it, never from the API's
 * response, whether a transaction needs the intermediary's co-signature.
 */
export function requiresMediator(address: string): boolean {
  return mediatorAllowedFor(address);
}
