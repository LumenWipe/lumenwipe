import { Logger } from "@nestjs/common";
import type {
  DefiEnrichmentEntry,
  DefiPosition,
  DefiPositionDisplay,
  DefiPositionsResult,
  DefiProtocol,
} from "@lumenwipe/types";
import { blendPositionEnricher } from "./blend";
import type { EnrichContext, EnrichDeps, PositionEnricher } from "./shared";
import { positionKey } from "./shared";

export {
  formatUnits,
  knownTokensFor,
  positionKey,
  type EnrichContext,
  type EnrichDeps,
  type KnownToken,
  type PositionEnricher,
} from "./shared";

/**
 * Presentation for detected positions (issue #197): what a person should read about each one, in
 * the protocol's own terms - the pool by name, the asset by symbol, the underlying amount rather
 * than a share count, the current yield. Resolved from a live read at analysis time, per protocol,
 * with the same plug-in shape as the exit catalog.
 *
 * Presentation only, by construction: an enricher returns display data or nothing, never a
 * blocker; a failure (network, timeout, a pool the SDK cannot read) is logged and leaves the
 * position exactly as detection reported it. Nothing here feeds the plan, the gate, or an exit.
 */

const DEFAULT_ENRICHERS: Partial<Record<DefiProtocol, PositionEnricher>> = {
  blend: blendPositionEnricher(),
};

export const DEFAULT_ENRICH_TIMEOUT_MS = 8_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * Returns a copy of the detection result with `display` attached to every position an enricher
 * could describe, and the provider's enrichment map completed with the tokens the account read
 * already knows. The input is never mutated; positions, unrecognized entries, source, and
 * timestamp pass through untouched.
 */
export async function enrichDefiPositions(
  result: DefiPositionsResult,
  ctx: EnrichContext,
  deps: Partial<EnrichDeps> = {}
): Promise<DefiPositionsResult> {
  const enrichers = deps.enrichers ?? DEFAULT_ENRICHERS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_ENRICH_TIMEOUT_MS;
  const logger = deps.logger ?? new Logger("defi-enrichment");

  const enrichment: Record<string, DefiEnrichmentEntry> = { ...result.enrichment };
  for (const [address, token] of Object.entries(ctx.knownTokens)) {
    // The provider's entry wins: it may carry a price; ours is only a name.
    enrichment[address] ??= {
      symbol: token.symbol,
      decimals: token.decimals,
      usdPrice: null,
      priceSource: null,
    };
  }

  if (result.positions.length === 0) return { ...result, enrichment };

  const byProtocol = new Map<DefiProtocol, DefiPosition[]>();
  for (const position of result.positions) {
    const group = byProtocol.get(position.protocol) ?? [];
    group.push(position);
    byProtocol.set(position.protocol, group);
  }

  const displays = new Map<string, DefiPositionDisplay>();
  await Promise.all(
    [...byProtocol.entries()].map(async ([protocol, positions]) => {
      const enricher = enrichers[protocol];
      if (!enricher) return;
      try {
        const resolved = await withTimeout(
          enricher(positions, ctx),
          timeoutMs,
          `${protocol} enrichment`
        );
        for (const [key, display] of resolved) displays.set(key, display);
      } catch (e) {
        // Presentation only: the positions stay as detected, without a display.
        logger.warn(
          `${protocol} position enrichment skipped for ${ctx.account} on ${ctx.network}: ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    })
  );

  const positions = result.positions.map((position) => {
    const display = displays.get(positionKey(position));
    return display ? { ...position, display } : position;
  });
  return { ...result, positions, enrichment };
}
