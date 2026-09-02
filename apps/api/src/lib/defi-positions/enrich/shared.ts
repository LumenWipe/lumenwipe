import type { Logger } from "@nestjs/common";
import { Asset } from "@stellar/stellar-sdk";
import type {
  DefiPosition,
  DefiPositionDisplay,
  DefiProtocol,
  Network,
  Trustline,
} from "@lumenwipe/types";
import { NETWORK_PASSPHRASES } from "@/config/networks";

/** What every enricher shares with the catalog in index.ts - kept apart so an enricher never
 *  imports the catalog that registers it. */

export interface KnownToken {
  symbol: string;
  decimals: number;
}

export interface EnrichContext {
  network: Network;
  /** The account being analyzed. */
  account: string;
  /** Tokens the account read already names, by Stellar Asset Contract id: XLM and every
   *  trustline. Always available, so these symbols never depend on the provider. */
  knownTokens: Record<string, KnownToken>;
}

/** Resolves display data for the positions of ONE protocol, keyed by `positionKey`. */
export type PositionEnricher = (
  positions: DefiPosition[],
  ctx: EnrichContext
) => Promise<Map<string, DefiPositionDisplay>>;

export interface EnrichDeps {
  enrichers: Partial<Record<DefiProtocol, PositionEnricher>>;
  /** Wall-clock budget per protocol; the analysis must not hang on a slow pool read. */
  timeoutMs: number;
  logger?: Pick<Logger, "warn">;
}

/** Identifies a detected position for the enricher's answer: contract, kind, and asset when it has one. */
export function positionKey(position: DefiPosition): string {
  const asset = "assetAddress" in position ? position.assetAddress : "";
  return `${position.contractAddress}:${position.positionType}:${asset}`;
}

/** XLM and every trustline, by the SAC id a contract would name them with. */
export function knownTokensFor(
  trustlines: Trustline[],
  network: Network
): Record<string, KnownToken> {
  const passphrase = NETWORK_PASSPHRASES[network];
  const known: Record<string, KnownToken> = {
    [Asset.native().contractId(passphrase)]: { symbol: "XLM", decimals: 7 },
  };
  for (const tl of trustlines) {
    known[new Asset(tl.code, tl.issuer).contractId(passphrase)] = { symbol: tl.code, decimals: 7 };
  }
  return known;
}

/** Base units to a decimal string in the token's own units, exact, without trailing zeros. */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals === 0 ? "" : digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
