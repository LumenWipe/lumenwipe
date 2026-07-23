import { STROOPS_PER_XLM } from "@/config/constants";

export function stroopsToXlm(stroops: string | number | bigint): string {
  const n = BigInt(stroops);
  const whole = n / BigInt(STROOPS_PER_XLM);
  const frac = n % BigInt(STROOPS_PER_XLM);
  const fracStr = frac.toString().padStart(7, "0");
  return `${whole}.${fracStr}`.replace(/\.?0+$/, "") || "0";
}

export function xlmToStroops(xlm: string): string {
  const [whole, frac = ""] = xlm.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return (BigInt(whole) * BigInt(STROOPS_PER_XLM) + BigInt(fracPadded)).toString();
}

export function formatXlm(lumens: string, decimals = 2): string {
  const n = parseFloat(lumens);
  if (isNaN(n)) return "0 XLM";
  return `${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: 7 })} XLM`;
}

export function estimateFeeLumens(operationCount: number): string {
  // 100 stroops per operation
  const stroops = operationCount * 100;
  return stroopsToXlm(stroops);
}

export function calcRecoverableReserve(numSubEntries: number): string {
  // Each subentry releases 0.5 XLM when removed
  return (numSubEntries * 0.5).toFixed(7);
}
