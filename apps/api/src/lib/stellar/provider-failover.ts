/**
 * Ordered failover across the Horizon-compatible providers of a network.
 *
 * A failing provider restarts the whole read on the next one: stitching two providers would pair
 * one ledger's sub-entry count with another's offers. Only an outage or a non-conforming answer
 * moves on. Anything that is an answer about the account stops here, so a caller can never shop
 * providers for one that has not seen a change yet.
 */

import { Logger } from "@nestjs/common";
import type { Deadline } from "@/common/deadline";
import { currentProviderPins } from "@/common/request-context";
import { horizonProviders, hostnameOf, type Network } from "@/config/networks";
import { AccountNotFoundError, UnusableProviderResponseError } from "@/lib/utils/errors";
import type { HorizonDeps } from "./horizon-http";
import { DEFAULT_UPSTREAM_POLICY, resolveDeadline, UpstreamError } from "./upstream-client";

const logger = new Logger("provider-failover");

let failoverCount = 0;

/** Moves to a later provider since this process started. */
export function providerFailoverCount(): number {
  return failoverCount;
}

/** Test-only: clears the counter so one test's failovers don't leak into another's assertion. */
export function resetProviderFailoverCount(): void {
  failoverCount = 0;
}

export function recordProviderFailover(
  kind: "rpc" | "horizon",
  network: Network,
  from: string,
  to: string,
  reason: string
): void {
  failoverCount++;
  logger.warn({
    message: "provider failover",
    kind,
    network,
    from: hostnameOf(from),
    to: hostnameOf(to),
    reason,
  });
}

/** Allowlist: an error nobody classified is never a reason to ask another provider. */
export function isRetryableProviderFailure(error: unknown): boolean {
  return error instanceof UpstreamError || error instanceof UnusableProviderResponseError;
}

function failureReason(error: unknown): string {
  return error instanceof UpstreamError ? error.kind : "unusable_response";
}

/**
 * The cap keeps dead providers from spending a budget a live one further down needs, and no
 * retries before the last provider for the same reason. Both override the caller's own policy.
 */
function boundAttempt(provider: HorizonDeps, deadline: Deadline, providersLeft: number) {
  if (providersLeft === 1) return { ...provider, deadline };
  const policy = provider.client?.policy;
  const perAttemptMs = Math.min(
    policy?.perAttemptMs ?? DEFAULT_UPSTREAM_POLICY.perAttemptMs,
    Math.floor(deadline.remainingMs() / providersLeft)
  );
  return {
    ...provider,
    deadline,
    client: { ...provider.client, policy: { ...policy, maxRetries: 0, perAttemptMs } },
  };
}

/**
 * Runs `read` against `primary`, then each of `fallbacks` in turn on a retryable failure. With no
 * fallbacks it is exactly one call to `read`. When every provider fails the caller gets a typed
 * `unavailable`. A 404 from a fallback is a provider that may simply be behind, so it is never
 * taken for "this account does not exist".
 */
export async function withHorizonFailover<T>(
  network: Network,
  primary: HorizonDeps,
  fallbacks: HorizonDeps[],
  read: (attempt: HorizonDeps, isPrimary: boolean) => Promise<T>
): Promise<T> {
  if (fallbacks.length === 0) return read(primary, true);

  const deadline = resolveDeadline(primary.deadline);
  const chain = [primary, ...fallbacks];
  for (const [i, provider] of chain.entries()) {
    try {
      return await read(boundAttempt(provider, deadline, chain.length - i), i === 0);
    } catch (error) {
      const failure =
        i > 0 && error instanceof AccountNotFoundError
          ? new UpstreamError("unavailable", "horizon")
          : error;
      if (!isRetryableProviderFailure(failure)) throw failure;
      const next = chain[i + 1];
      if (!next || deadline.signal.aborted) break;
      recordProviderFailover(
        "horizon",
        network,
        provider.baseUrl,
        next.baseUrl,
        failureReason(failure)
      );
    }
  }
  throw new UpstreamError("unavailable", "horizon");
}

/** Everything after the first provider, ready for `withHorizonFailover`. */
export function horizonFallbacksFor(
  network: Network,
  fetchImpl?: typeof globalThis.fetch
): HorizonDeps[] {
  return horizonProviders(network)
    .slice(1)
    .map(({ url, headers }) => ({ baseUrl: url, headers, fetch: fetchImpl }));
}

export type HorizonSource = Pick<HorizonDeps, "baseUrl" | "headers" | "fetch">;

const pinKey = (network: Network): string => `horizon:${network}`;

/** Remembers the provider the account snapshot came from, for reads that depend on it later. */
export function pinHorizonSource(network: Network, source: HorizonSource): void {
  currentProviderPins()?.set(pinKey(network), source);
}

export function pinnedHorizonSource(network: Network): HorizonSource | undefined {
  return currentProviderPins()?.get(pinKey(network)) as HorizonSource | undefined;
}
