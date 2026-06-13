export function horizonAssetToString(a: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): string {
  if (a.asset_type === "native") return "native";
  return `${a.asset_code}:${a.asset_issuer}`;
}

export function parseAsset(assetStr: string): { code: string; issuer: string | null } {
  if (assetStr === "native" || assetStr === "XLM") {
    return { code: "XLM", issuer: null };
  }
  const parts = assetStr.split(":");
  return { code: parts[0], issuer: parts[1] ?? null };
}

export function formatAsset(assetStr: string): string {
  const { code } = parseAsset(assetStr);
  return code;
}

export function isNativeAsset(assetStr: string): boolean {
  return assetStr === "native" || assetStr === "XLM";
}

export function assetToSdkAsset(assetStr: string) {
  const { Asset } = require("@stellar/stellar-sdk");
  if (isNativeAsset(assetStr)) return Asset.native();
  const { code, issuer } = parseAsset(assetStr);
  return new Asset(code, issuer!);
}

export function sdkAssetToString(asset: {
  isNative(): boolean;
  getCode(): string;
  getIssuer(): string;
}): string {
  if (asset.isNative()) return "native";
  return `${asset.getCode()}:${asset.getIssuer()}`;
}
