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
import { isRegistryFresh } from "@/lib/contract-registry";
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
 *  "cache" | "not-tracked") or the designed testnet source ("testnet-direct-read"). Used both
 *  when the direct-read fallback itself also failed and when it succeeded but found a real
 *  position - either way, positions-gate.ts's null-timestamp rule is what surfaces the warning,
 *  not this string. */
export const DEGRADED_SOURCE = "octopos-degraded-fallback";

/** Like DEGRADED_SOURCE, but the direct-read fallback actually completed and swept every
 *  registered protocol without finding anything - a materially stronger signal than "we
 *  couldn't check at all" (RPC also down, or OctoPos's response was unparseable). Still not a
 *  primary-vendor snapshot, so timestamp stays null and this still gates by default; it exists
 *  so a caller that also knows the account has zero trustlines (ruling out classic AMM
 *  positions) can tell this case apart from a genuinely unconfirmed one. */
export const DEGRADED_SOURCE_CONFIRMED_EMPTY = "octopos-degraded-direct-read-confirmed-empty";

/** The direct-read fallback sweeps every registered protocol of the network (hundreds of pools
 *  on mainnet); past this it reports "detected nothing" rather than holding the analysis.
 *
 *  This was cut to 8s for latency, without measuring the real sweep against production RPC
 *  first - confirmed live on 2026-09-12 (a real zero-trustline mainnet account, `source`
 *  consistently landing on DEGRADED_SOURCE rather than DEGRADED_SOURCE_CONFIRMED_EMPTY across
 *  repeated requests) that 8s is not enough for the sweep to ever actually finish, which makes
 *  positions-gate.ts's confirmed-empty leniency effectively unreachable - the exact case it was
 *  built for. Restored to the value this ran on before that cut. OctoPos's own ~5.3s worst case
 *  (octopos-http.ts) still keeps the combined DeFi-detection budget well short of this, and the
 *  web proxy's maxDuration and SDK client timeout are sized with this number in mind - lower it
 *  again only after measuring the real sweep duration, not by guessing. */
export const DIRECT_READ_FALLBACK_TIMEOUT_MS = 20_000;

const logger = new Logger("resolve-defi-positions");

/** Calls into degraded mode since this process started (same pattern as horizon-http.ts's
 *  rateLimitHits): surfaced at /health so a rising count - OctoPos degrading more than
 *  expected - is an operational signal, not something discovered from a user's screenshot. */
let degradedFallbackCallCount = 0;

export function degradedFallbackCount(): number {
  return degradedFallbackCallCount;
}

/** Test-only: clears the counter so one test's degraded calls don't leak into another's
 *  assertion. */
export function resetDegradedFallbackCount(): void {
  degradedFallbackCallCount = 0;
}

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
  degradedFallbackCallCount++;
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
    // A registry past its validUntil can't back a genuine "we swept everything" claim - rotated
    // addresses or a protocol never added would sweep clean too. soroswapConversionContracts
    // already fails closed on this same flag for conversions; detection needs the same rule.
    const confirmedEmpty =
      isRegistryFresh() &&
      direct.positions.length === 0 &&
      direct.unrecognizedPositions.length === 0;
    return {
      ...direct,
      source: confirmedEmpty ? DEGRADED_SOURCE_CONFIRMED_EMPTY : DEGRADED_SOURCE,
      timestamp: null,
    };
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
  // OctoPos's genuine "not-tracked" carries the same "no confirmed snapshot" status as an
  // outage (positions-gate.ts already gates both identically), so it gets the same shot at a
  // direct-read confirmation rather than a hard blocker with no on-chain check ever attempted.
  if (normalized.source === "not-tracked") {
    return degradedFallback(address, network, deps, "not-tracked by OctoPos");
  }
  // `source` is normalizeOctoPosPortfolio's verbatim pass-through of the vendor's raw response
  // field - untrusted input. DEGRADED_SOURCE and DEGRADED_SOURCE_CONFIRMED_EMPTY are internal
  // markers this module alone may assign, only after a direct read has actually run; a
  // malicious or compromised OctoPos claiming either one here would let a forged "already
  // confirmed empty" bypass positions-gate.ts's trustline-based leniency without any on-chain
  // check ever happening. Treated as unrecognizable so a real direct read runs regardless.
  if (
    normalized.source === DEGRADED_SOURCE ||
    normalized.source === DEGRADED_SOURCE_CONFIRMED_EMPTY
  ) {
    return degradedFallback(address, network, deps, "OctoPos claimed a reserved internal source");
  }
  // The indexer names an LP position by pool and shares only; the exit's verifier needs the
  // pool's tokens (and share token) too, read from the pool itself. Never throws.
  return completePositionsFromLedger(normalized, network, deps.complete);
}
