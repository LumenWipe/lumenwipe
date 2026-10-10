import type { Network } from "@/config/networks";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { SLIPPAGE_BPS } from "@/config/constants";
import type { Deadline } from "@/common/deadline";
import { UpstreamError, upstreamGetJson, type UpstreamOptions } from "./upstream-client";
import type { ConversionPath } from "@lumenwipe/types";
import { isNativeAsset, parseAsset } from "@/lib/utils/assets";
import { stroopsToXlm, xlmToStroops } from "@/lib/utils/amounts";

interface PathRecordAsset {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface PathRecord {
  destination_amount: string;
  path: PathRecordAsset[];
}

interface PathsResponse {
  _embedded?: { records?: PathRecord[] };
}

function recordAssetToString(asset: PathRecordAsset): string {
  if (asset.asset_type === "native") return "native";
  return `${asset.asset_code}:${asset.asset_issuer}`;
}

/** Exported for direct unit coverage of the rounding boundary (issue #167) - the only caller in
 *  production code remains `fetchConversionPath` below. */
export function applySlippage(amount: string): string {
  const stroops = BigInt(xlmToStroops(amount));
  const min = (stroops * BigInt(10000 - SLIPPAGE_BPS)) / BigInt(10000);
  return min > BigInt(0) ? stroopsToXlm(min) : "0";
}

/**
 * What the price source said. `none` is an answer (the asset has no route to the target);
 * `unavailable` is the absence of one, and must never be read as `none`.
 */
export type PathResult =
  | { kind: "route"; path: ConversionPath }
  | { kind: "none" }
  | { kind: "unavailable"; error: UpstreamError };

export interface PathFindingOptions {
  fetch?: typeof globalThis.fetch;
  deadline?: Deadline;
  client?: Pick<UpstreamOptions, "policy" | "random" | "sleep" | "now">;
}

/** The route, or null when there is none; an unavailable price source throws instead of
 *  reading as "no route". */
export function routeOrNull(result: PathResult): ConversionPath | null {
  if (result.kind === "unavailable") throw result.error;
  return result.kind === "route" ? result.path : null;
}

export async function fetchConversionPath(
  fromAsset: string,
  amount: string,
  network: Network,
  toAsset = "native",
  options: PathFindingOptions = {}
): Promise<PathResult> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) return { kind: "unavailable", error: new UpstreamError("unavailable", "paths") };
  if (isNativeAsset(fromAsset) || !(parseFloat(amount) > 0)) return { kind: "none" };

  const { code, issuer } = parseAsset(fromAsset);
  if (!issuer) return { kind: "none" };

  const url = new URL(`${base}/paths/strict-send`);
  url.searchParams.set(
    "source_asset_type",
    code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12"
  );
  url.searchParams.set("source_asset_code", code);
  url.searchParams.set("source_asset_issuer", issuer);
  url.searchParams.set("source_amount", amount);
  url.searchParams.set("destination_assets", toAsset);

  let data: PathsResponse | null;
  try {
    data = await upstreamGetJson<PathsResponse>(url.toString(), {
      target: "paths",
      fetch: options.fetch,
      deadline: options.deadline,
      ...options.client,
    });
  } catch (error) {
    if (error instanceof UpstreamError) return { kind: "unavailable", error };
    throw error;
  }

  const records = data?._embedded?.records ?? [];
  if (records.length === 0) return { kind: "none" };

  const best = records.reduce((a, b) =>
    parseFloat(b.destination_amount) > parseFloat(a.destination_amount) ? b : a
  );

  const destMin = applySlippage(best.destination_amount);
  if (destMin === "0") return { kind: "none" };

  return {
    kind: "route",
    path: {
      fromAsset,
      toAsset,
      path: best.path.map(recordAssetToString),
      estimatedReceive: best.destination_amount,
      destMin,
    },
  };
}
