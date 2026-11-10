/**
 * `@lumenwipe/verify`: the verifier the LumenWipe web app runs before every signature, compiled
 * from the web's own modules rather than copied, together with the web's trust anchor for an
 * allowance revocation. There is one implementation; this file only
 * gives it explicit, documented types. `tests/types.test.ts` pins every type below to the web
 * signature in both directions, so a change on either side fails the build.
 *
 * @packageDocumentation
 */
import type {
  AccountSigner,
  AccountState,
  AccountThresholds,
  ExchangeRegistryEntry,
} from "@lumenwipe/types";
import { verifyCloseTransaction as webVerifyCloseTransaction } from "../../../apps/web/lib/stellar/verify";
import { exitExpectations as webExitExpectations } from "../../../apps/web/lib/stellar/exit-expectations";
import { mediatorAllowedFor } from "../../../apps/web/lib/exchange-registry";
import { verifyRevokeAllowanceTransaction as webVerifyRevokeAllowanceTransaction } from "../../../apps/web/lib/stellar/verify-revoke-allowance";

export {
  VerificationError,
  type VerificationErrorCode,
} from "../../../apps/web/lib/stellar/verification-error";
export {
  RevokeAllowanceVerificationError,
  type RevokeAllowanceVerificationErrorCode,
} from "../../../apps/web/lib/stellar/verify-revoke-allowance";
export type { AccountSigner, AccountState, AccountThresholds, ExchangeRegistryEntry };

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
 * exchange registry bundled in this package, tightened by a served snapshot when one is passed
 * ({@link VerifyCloseInput.servedRegistry}).
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
  /** The type the user confirmed for `memo`, or null with no memo. The bundled registry's type
   *  replaces it for an exchange the bundle lists; a served registry's type that differs from it
   *  is refused (`registry_memo_type_unconfirmed`), never adopted. */
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

/**
 * A served exchange registry: the body of `GET /v1/config/exchange-registry` (the SDK's
 * `client.getExchangeRegistry()`), passed as is. Only these three fields are read.
 *
 * It is not authenticated, and it does not need to be for what it can do: it is merged over the
 * registry bundled in this package and can only make verification stricter.
 *
 * - A bundled exchange is never removed, and its memo requirement and its refusal of a direct
 *   merge are never turned off.
 * - An address it adds is checked as an exchange: a direct merge into it is refused when it
 *   needs the intermediary, a memo is required when it needs one, and a transfer to it is refused.
 * - It never enables the mediated hand-off. That stays limited to the exchanges the bundled
 *   registry lists ({@link requiresMediator}), so an address only the snapshot lists as needing
 *   the intermediary refuses both shapes until this package is updated.
 * - Its `validUntil` may move the bundled expiry later, by at most 120 days, never earlier.
 * - It never decides a memo type. A different type for a bundled exchange is refused with
 *   `registry_memo_type_conflict`, and a type for an address it adds that differs from the one
 *   the user confirmed is refused with `registry_memo_type_unconfirmed`. A memo sent under the
 *   wrong type reaches the exchange and is credited to nobody.
 *
 * An entry's `name` is taken from it, and only used in refusal messages.
 */
export interface ServedRegistry {
  /** The listed exchanges. An entry that is not well formed is dropped. */
  entries: ExchangeRegistryEntry[];
  /** When the entries were last checked (YYYY-MM-DD). Not used to decide anything. */
  lastVerified: string;
  /** The date (YYYY-MM-DD) after which the registry is not relied on. */
  validUntil: string;
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
  /** A served exchange registry to apply over the bundled one, stricter-only. Omit it to use the
   *  bundled registry alone. A value that is not a registry (no `entries` list, no
   *  `lastVerified` or `validUntil` string) is refused with `registry_snapshot_invalid` rather
   *  than ignored. */
  servedRegistry?: ServedRegistry;
}

/**
 * Decodes an API-built, unsigned close transaction and asserts it does exactly what `expected`
 * says, using the exchange and contract registries bundled in this package. Returns only when the
 * transaction may be signed; throws {@link VerificationError} on any mismatch.
 *
 * Synchronous and offline: it reads no network and no page state, and keeps no state between
 * calls. It reads the system clock twice: for the transaction's expiry (at most 900 seconds
 * ahead) and for the exchange registry's `validUntil`, past which an exchange close is refused
 * until this package is updated or a served snapshot extends it.
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
 * response, whether a transaction needs the intermediary's co-signature. A served snapshot never
 * changes this answer, so it takes none.
 */
export function requiresMediator(address: string): boolean {
  return mediatorAllowedFor(address);
}

/**
 * What the screen showed the user before they approved an allowance revocation: the allowance
 * the revocation must zero, and nothing else. Every value is one the integrator already displayed,
 * never one read from the transaction under verification.
 */
export interface RevokeAllowanceExpectation {
  /** The account whose allowance is revoked. The transaction and its one operation must be
   *  sourced from it, and it is the only account the call may authorize. */
  owner: string;
  /** The token contract (`C...`) `approve` is called on. */
  token: string;
  /** The spender whose allowance goes to zero: a contract (`C...`) or, less often, an account
   *  (`G...`). */
  spender: string;
}

/**
 * Decodes an API-built, unsigned allowance revocation and asserts it is exactly
 * `approve(owner, spender, 0, expiration)` on `token`: one operation, sourced from `owner`, no
 * memo, a fee of at most 10,000,000 stroops, valid for at most 900 seconds after `nowSeconds`,
 * authorized only by the owner's own source account with no nested call, and naming no other
 * account or contract. Returns only when the transaction may be signed.
 *
 * What it guarantees is that the signed transaction does what the screen said, so an API cannot
 * swap the token or the spender between what was shown and what is signed. It does not judge
 * whether the shown allowance is worth revoking.
 *
 * Throws {@link RevokeAllowanceVerificationError} with a stable `code` on any mismatch, or
 * {@link VerificationError} when the envelope cannot be decoded at all (for example a text memo
 * that is not valid UTF-8). Synchronous and offline: it reads no network and no page state, and
 * keeps no state between calls. Run it once per transaction, immediately before the signature.
 *
 * @param unsignedXdr - The unsigned transaction envelope as returned by the API, base64.
 * @param networkPassphrase - The passphrase of the network the revocation runs on.
 * @param expected - The allowance the screen showed.
 * @param nowSeconds - The current Unix time in seconds; defaults to the system clock.
 */
export function verifyRevokeAllowanceTransaction(
  unsignedXdr: string,
  networkPassphrase: string,
  expected: RevokeAllowanceExpectation,
  nowSeconds?: number
): void {
  webVerifyRevokeAllowanceTransaction(unsignedXdr, networkPassphrase, expected, nowSeconds);
}
