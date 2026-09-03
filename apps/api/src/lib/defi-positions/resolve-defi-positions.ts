/**
 * The single entry point for "detect this address's DeFi positions" (architecture.md §7.1, issue
 * #149), tying the OctoPos adapter (#146) and the direct-contract-read path (#148) into one
 * degraded-mode-aware resolver. Nothing outside this module needs to know which provider path
 * actually served a given result.
 *
 * Testnet always takes the direct-read path - not a fallback there, the designed primary path,
 * since OctoPos is mainnet-only. Mainnet tries OctoPos first; an outage, an unconfigured
 * deployment, or a payload the adapter cannot recognize all degrade the same way: this function
 * never throws or rejects, so a DeFi-detection failure never blocks the rest of an analysis call.
 *
 * The degraded path still attempts the direct-contract-read fallback (best-effort, not a static
 * placeholder) rather than a separate stub, so the exact code every testnet CI run already
 * exercises is what actually runs during a real mainnet outage. Its result is stamped with a
 * null timestamp regardless of what the direct read found - `assessDefiPositionsGate`
 * (positions-gate.ts) already treats a null timestamp as "no confirmed snapshot" and surfaces the
 * plain-language "verify manually" warning this issue asks for, so degraded mode needs no second
 * warning mechanism of its own.
 *
 * The direct-read fallback itself depends on live RPC, which can fail too (a genuine RPC outage,
 * not an OctoPos one). That failure is caught here as well: an account already in degraded mode
 * because OctoPos is down must not lose the entire analysis call to a second, unrelated failure.
 * It reports an empty degraded result instead - honest about detecting nothing, not a crash.
 */

import { Logger } from "@nestjs/common";
import type { DefiPositionsResult, Network } from "@lumenwipe/types";
import { completePositionsFromLedger, type CompletePositionsDeps } from "./complete-positions";
import { fetchOctoPosPortfolio, type OctoPosDeps } from "./octopos-http";
import { normalizeOctoPosPortfolio } from "./octopos-adapter";
import { detectDefiPositionsViaDirectRead, type DirectReadDeps } from "./testnet-direct-read";

export interface ResolveDefiPositionsDeps {
  octopos: OctoPosDeps;
  directRead?: DirectReadDeps;
  /** The ledger reads that complete an indexer's LP positions; defaults to the network's RPC. */
  complete?: CompletePositionsDeps;
}

/** Distinguishes a degraded-mode result from a real OctoPos source ("snapshot" | "empty" |
 *  "cache" | "not-tracked") or the designed testnet source ("testnet-direct-read"). */
export const DEGRADED_SOURCE = "octopos-degraded-fallback";

/** The direct-read fallback sweeps every registered protocol of the network (hundreds of pools
 *  on mainnet); past this it reports "detected nothing" rather than holding the analysis. */
export const DIRECT_READ_FALLBACK_TIMEOUT_MS = 20_000;

const logger = new Logger("resolve-defi-positions");

function emptyDegradedResult(address: string, network: Network): DefiPositionsResult {
  return {
    address,
    network,
    positions: [],
    unrecognizedPositions: [],
    enrichment: {},
    source: DEGRADED_SOURCE,
    timestamp: null,
    queryKeys: {
      rpcEndpoints: [],
      rpcPolicy: { maxKeysPerCall: 0, recommendedConcurrency: 0, backoffOn429Ms: [], timeoutMs: 0 },
      slices: {},
    },
  };
}

async function degradedFallback(
  address: string,
  network: Network,
  deps: ResolveDefiPositionsDeps,
  reason: string
): Promise<DefiPositionsResult> {
  logger.warn(
    `OctoPos unavailable for ${network} (${reason}); falling back to a best-effort direct read`
  );
  try {
    const direct = await Promise.race([
      detectDefiPositionsViaDirectRead(address, network, deps.directRead),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`direct read exceeded ${DIRECT_READ_FALLBACK_TIMEOUT_MS} ms`)),
          DIRECT_READ_FALLBACK_TIMEOUT_MS
        ).unref?.()
      ),
    ]);
    return { ...direct, source: DEGRADED_SOURCE, timestamp: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `direct-read fallback for ${network} also failed (${message}); reporting unavailable`
    );
    return emptyDegradedResult(address, network);
  }
}

export async function resolveDefiPositions(
  address: string,
  network: Network,
  deps: ResolveDefiPositionsDeps
): Promise<DefiPositionsResult> {
  if (network === "testnet") {
    return detectDefiPositionsViaDirectRead(address, network, deps.directRead);
  }

  const fetched = await fetchOctoPosPortfolio(address, deps.octopos);
  if (!fetched.ok) {
    return degradedFallback(address, network, deps, `${fetched.reason}: ${fetched.detail}`);
  }

  let normalized: DefiPositionsResult;
  try {
    normalized = normalizeOctoPosPortfolio(fetched.raw, address, network);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return degradedFallback(address, network, deps, `unrecognizable response: ${message}`);
  }
  // The indexer names an LP position by pool and shares only; the exit's verifier needs the
  // pool's tokens (and share token) too, read from the pool itself. Never throws.
  return completePositionsFromLedger(normalized, network, deps.complete);
}
