/**
 * The upstream health behind `GET /health/dependencies`.
 *
 * The route is public, so everything a row carries comes from the fixed unions below: no host,
 * key, balance or upstream text can reach it. Probes run only on demand, each row cached and
 * coalesced, so a poller cannot turn into more upstream traffic than one probe per TTL.
 */

import { createDeadline } from "@/common/deadline";
import {
  horizonProviders,
  VALID_NETWORKS,
  WELL_KNOWN_ISSUERS,
  rpcProviders,
  type Network,
} from "@/config/networks";
import { fetchOctoPosPortfolio } from "@/lib/defi-positions/octopos-http";
import { defiPositionsDepsFor } from "@/lib/stellar/account-state";
import { buildRpcServer } from "@/lib/stellar/rpc";
import {
  UpstreamError,
  upstreamGetJson,
  type UpstreamErrorKind,
} from "@/lib/stellar/upstream-client";
import { withTimeout } from "@/lib/utils/with-timeout";

export const PROBE_TIMEOUT_MS = 3_000;
export const CORE_PROBE_TTL_MS = 60_000;
/** Longer: these two spend third-party quota on an unauthenticated route. */
export const QUOTA_PROBE_TTL_MS = 300_000;

export type DependencyName = "rpc" | "horizon" | "paths" | "defi";
export type DependencyState = "up" | "degraded" | "down" | "unconfigured";

export interface DependencyStatus {
  upstream: DependencyName;
  network: Network;
  state: DependencyState;
  latencyMs: number | null;
  lastSuccessAt: string | null;
  lastErrorClass: UpstreamErrorKind | null;
}

/** One entry per provider, null when it answered; empty when none is configured. */
type ProbeRun = () => Promise<Array<UpstreamErrorKind | null>>;

export interface DependencyProbe {
  upstream: DependencyName;
  network: Network;
  ttlMs: number;
  run: ProbeRun;
}

function errorClass(error: unknown): UpstreamErrorKind {
  return error instanceof UpstreamError ? error.kind : "unavailable";
}

const outcome = (attempt: Promise<unknown>): Promise<UpstreamErrorKind | null> =>
  attempt.then(() => null, errorClass);

function rpcProbe(network: Network): ProbeRun {
  return () =>
    Promise.all(
      rpcProviders(network).map(async (provider) => {
        const startedAt = Date.now();
        const server = buildRpcServer(network, { timeout: PROBE_TIMEOUT_MS, provider });
        const failure = await outcome(server.getHealth());
        if (failure === null) return null;
        return Date.now() - startedAt >= PROBE_TIMEOUT_MS ? "timeout" : failure;
      })
    );
}

function horizonProbe(network: Network, target: "horizon" | "paths", path: string): ProbeRun {
  return () =>
    Promise.all(
      horizonProviders(network).map(({ url, headers }) =>
        outcome(
          upstreamGetJson(url, path, {
            target,
            network,
            headers,
            deadline: createDeadline(PROBE_TIMEOUT_MS),
            policy: { maxRetries: 0, perAttemptMs: PROBE_TIMEOUT_MS },
          })
        )
      )
    );
}

async function defiProbe(): Promise<Array<UpstreamErrorKind | null>> {
  const { octopos } = defiPositionsDepsFor();
  if (!octopos.baseUrl) return [];
  // The body is discarded, and the address is a public issuer rather than anyone's wallet.
  const read = fetchOctoPosPortfolio(WELL_KNOWN_ISSUERS.mainnet, octopos);
  try {
    const result = await withTimeout(read, PROBE_TIMEOUT_MS, "timed out");
    return [result.ok ? null : "unavailable"];
  } catch {
    return ["timeout"];
  }
}

export function liveDependencyProbes(): DependencyProbe[] {
  return [
    ...VALID_NETWORKS.flatMap((network): DependencyProbe[] => [
      { upstream: "rpc", network, ttlMs: CORE_PROBE_TTL_MS, run: rpcProbe(network) },
      {
        upstream: "horizon",
        network,
        ttlMs: CORE_PROBE_TTL_MS,
        run: horizonProbe(network, "horizon", "/ledgers?order=desc&limit=1"),
      },
      {
        upstream: "paths",
        network,
        ttlMs: QUOTA_PROBE_TTL_MS,
        run: horizonProbe(
          network,
          "paths",
          "/paths/strict-send?source_asset_type=native&source_amount=1" +
            `&destination_assets=USDC:${WELL_KNOWN_ISSUERS[network]}`
        ),
      },
    ]),
    { upstream: "defi", network: "mainnet", ttlMs: QUOTA_PROBE_TTL_MS, run: defiProbe },
  ];
}

function stateOf(results: ReadonlyArray<UpstreamErrorKind | null>): DependencyState {
  if (results.length === 0) return "unconfigured";
  const answered = results.filter((r) => r === null).length;
  if (answered === results.length) return "up";
  return answered > 0 ? "degraded" : "down";
}

interface Row {
  probe: DependencyProbe;
  status: DependencyStatus;
  expiresAt: number;
  running: Promise<DependencyStatus> | null;
}

export class DependencyProbes {
  private readonly rows: Row[];

  constructor(
    probes: DependencyProbe[],
    private readonly now: () => number = Date.now
  ) {
    this.rows = probes.map((probe) => ({
      probe,
      status: {
        upstream: probe.upstream,
        network: probe.network,
        state: "unconfigured",
        latencyMs: null,
        lastSuccessAt: null,
        lastErrorClass: null,
      },
      expiresAt: 0,
      running: null,
    }));
  }

  statuses(): Promise<DependencyStatus[]> {
    return Promise.all(this.rows.map((row) => this.current(row)));
  }

  private current(row: Row): Promise<DependencyStatus> {
    if (row.expiresAt > this.now()) return Promise.resolve(row.status);
    row.running ??= this.refresh(row).finally(() => {
      row.running = null;
    });
    return row.running;
  }

  private async refresh(row: Row): Promise<DependencyStatus> {
    const startedAt = this.now();
    const results = await row.probe.run().catch((): Array<UpstreamErrorKind | null> => {
      return ["unavailable"];
    });
    const finishedAt = this.now();
    const failure = results.find((r) => r !== null);
    const { lastSuccessAt, lastErrorClass } = row.status;
    row.status = {
      ...row.status,
      state: stateOf(results),
      latencyMs: results.length === 0 ? null : finishedAt - startedAt,
      lastSuccessAt: results.includes(null) ? new Date(finishedAt).toISOString() : lastSuccessAt,
      lastErrorClass: failure ?? lastErrorClass,
    };
    row.expiresAt = finishedAt + row.probe.ttlMs;
    return row.status;
  }
}
