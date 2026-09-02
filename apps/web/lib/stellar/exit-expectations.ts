import { Asset } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import type { AccountState } from "@/types/account";

/**
 * What the client can vouch for about a DeFi exit before signing it, taken from the account read
 * the user reviewed - the same honest footing `nativeBalance` and `accountSigners` stand on.
 *
 * - `exitContracts`: the pools, pairs, or vaults the analysis showed this account holds a
 *   position in. An exit may invoke only one of these, so a transaction cannot call an arbitrary
 *   contract just because the API said so.
 * - `heldTokenContracts`: the Stellar Asset Contract of every asset the account holds (native
 *   XLM and each trustline). An exit's arguments and authorization tree may name these - a
 *   repay spends one, a withdrawal receives one - and nothing else.
 *
 * Empty inputs fail closed: with no account read, every exit is refused rather than trusted.
 */
export interface ExitExpectations {
  exitContracts: string[];
  heldTokenContracts: string[];
}

export function exitExpectations(
  accountState: AccountState | null | undefined,
  network: Network
): ExitExpectations {
  if (!accountState) return { exitContracts: [], heldTokenContracts: [] };
  const passphrase = NETWORK_PASSPHRASES[network];
  // A read with no positions section (an older session, a partial state) vouches for nothing.
  const positions = accountState.defiPositions?.positions ?? [];
  const trustlines = accountState.trustlines ?? [];
  const exitContracts = [...new Set(positions.map((p) => p.contractAddress))];
  const heldTokenContracts = [
    Asset.native().contractId(passphrase),
    ...trustlines.map((tl) => new Asset(tl.code, tl.issuer).contractId(passphrase)),
  ];
  return { exitContracts, heldTokenContracts };
}
