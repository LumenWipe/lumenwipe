import { Asset } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { EXIT_FUNCTIONS, exitRoutersFor } from "@/lib/contract-registry";
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
 * - `exitFunctions`: for each contract an exit may invoke, the one function that leaves that
 *   protocol (a Blend pool's `submit`, a Soroswap router's `remove_liquidity`). The contracts
 *   themselves come from the API's read, so this is what stops a hostile read from turning a
 *   whitelisted contract into an arbitrary call.
 *
 * Empty inputs fail closed: with no account read, every exit is refused rather than trusted.
 */
export interface ExitExpectations {
  exitContracts: string[];
  heldTokenContracts: string[];
  positionTokenContracts: string[];
  exitFunctions: Record<string, string[]>;
}

export function exitExpectations(
  accountState: AccountState | null | undefined,
  network: Network
): ExitExpectations {
  if (!accountState) {
    return {
      exitContracts: [],
      heldTokenContracts: [],
      positionTokenContracts: [],
      exitFunctions: {},
    };
  }
  const passphrase = NETWORK_PASSPHRASES[network];
  // A read with no positions section (an older session, a partial state) vouches for nothing.
  const positions = accountState.defiPositions?.positions ?? [];
  const trustlines = accountState.trustlines ?? [];
  const routers = exitRoutersFor(
    network,
    positions.map((p) => p.protocol)
  );
  const exitContracts = [
    ...new Set([...positions.map((p) => p.contractAddress), ...routers.map((r) => r.address)]),
  ];
  const exitFunctions: Record<string, string[]> = {};
  for (const p of positions) {
    exitFunctions[p.contractAddress] = [...EXIT_FUNCTIONS[p.protocol].position];
  }
  for (const r of routers) exitFunctions[r.address] = [...EXIT_FUNCTIONS[r.protocol].router];
  const positionTokenContracts = [
    ...new Set(positions.flatMap((p) => ("tokens" in p && p.tokens ? p.tokens : []))),
  ];
  const heldTokenContracts = [
    Asset.native().contractId(passphrase),
    ...trustlines.map((tl) => new Asset(tl.code, tl.issuer).contractId(passphrase)),
  ];
  return { exitContracts, heldTokenContracts, positionTokenContracts, exitFunctions };
}
