import type { Network } from "@/config/networks";
import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { SE_API_TIMEOUT_MS, SLIPPAGE_BPS } from "@/config/constants";
import type { ConversionPath } from "@/types/plan";
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

function applySlippage(amount: string): string {
  const stroops = BigInt(xlmToStroops(amount));
  const min = (stroops * BigInt(10000 - SLIPPAGE_BPS)) / BigInt(10000);
  return min > BigInt(0) ? stroopsToXlm(min) : "0";
}

export async function fetchConversionPath(
  fromAsset: string,
  amount: string,
  network: Network,
  toAsset = "native"
): Promise<ConversionPath | null> {
  const base = PATH_ROUTING_API_URLS[network];
  if (!base || isNativeAsset(fromAsset) || !(parseFloat(amount) > 0)) return null;

  const { code, issuer } = parseAsset(fromAsset);
  if (!issuer) return null;

  const url = new URL(`${base}/paths/strict-send`);
  url.searchParams.set(
    "source_asset_type",
    code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12"
  );
  url.searchParams.set("source_asset_code", code);
  url.searchParams.set("source_asset_issuer", issuer);
  url.searchParams.set("source_amount", amount);
  url.searchParams.set("destination_assets", toAsset);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SE_API_TIMEOUT_MS);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = (await res.json()) as PathsResponse;
    const records = data._embedded?.records ?? [];
    if (records.length === 0) return null;

    const best = records.reduce((a, b) =>
      parseFloat(b.destination_amount) > parseFloat(a.destination_amount) ? b : a
    );

    const destMin = applySlippage(best.destination_amount);
    if (destMin === "0") return null;

    return {
      fromAsset,
      toAsset,
      path: best.path.map(recordAssetToString),
      estimatedReceive: best.destination_amount,
      destMin,
    };
  } catch {
    return null;
  }
}
