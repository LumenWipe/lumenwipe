import { Asset } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { exitRoutersFor } from "@/lib/contract-registry";
import type { AccountState } from "@/types/account";

/**
 * What the client can vouch for about a DeFi exit before signing it, taken from the account read
 * the user reviewed - the same honest footing `nativeBalance` and `accountSigners` stand on.
 *
 * - `exitContracts`: the pools, pairs, or vaults the analysis showed this account holds a
 *   position in, plus the bundled registry's routers for those protocols (an AMM withdrawal goes
 *   through the router, not the pair). An exit may invoke only one of these, so a transaction
 *   cannot call an arbitrary contract just because the API said so.
 * - `heldTokenContracts`: the Stellar Asset Contract of every asset the account holds (native
 *   XLM and each trustline). An exit's arguments and authorization tree may name these - a
 *   repay spends one, a withdrawal receives one.
 * - `positionTokenContracts`: the tokens of each position detection could read (an LP pair's
 *   two tokens). A withdrawal pays these out, so the call may name them too - and nothing else.
 *
 * Empty inputs fail closed: with no account read, every exit is refused rather than trusted.
 */
export interface ExitExpectations {
  exitContracts: string[];
  heldTokenContracts: string[];
  positionTokenContracts: string[];
}

export function exitExpectations(
  accountState: AccountState | null | undefined,
  network: Network
): ExitExpectations {
  if (!accountState) {
    return { exitContracts: [], heldTokenContracts: [], positionTokenContracts: [] };
  }
  const passphrase = NETWORK_PASSPHRASES[network];
  // A read with no positions section (an older session, a partial state) vouches for nothing.
  const positions = accountState.defiPositions?.positions ?? [];
  const trustlines = accountState.trustlines ?? [];
  const exitContracts = [
    ...new Set([
      ...positions.map((p) => p.contractAddress),
      ...exitRoutersFor(
        network,
        positions.map((p) => p.protocol)
      ),
    ]),
  ];
  const positionTokenContracts = [
    ...new Set(positions.flatMap((p) => ("tokens" in p && p.tokens ? p.tokens : []))),
  ];
  const heldTokenContracts = [
    Asset.native().contractId(passphrase),
    ...trustlines.map((tl) => new Asset(tl.code, tl.issuer).contractId(passphrase)),
  ];
  return { exitContracts, heldTokenContracts, positionTokenContracts };
}
