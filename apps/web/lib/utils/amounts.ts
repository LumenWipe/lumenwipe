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

/** A whole number of stroops as XLM with all seven decimals, exactly: no floating point. */
export function stroopsToFixedLumens(stroops: string): string {
  const n = BigInt(stroops);
  const unit = BigInt(STROOPS_PER_XLM);
  return `${n / unit}.${(n % unit).toString().padStart(7, "0")}`;
}

const LUMENS = /^(\d+)(?:\.(\d{1,7}))?$/;

/** An XLM amount for display, exactly as given: thousands grouped, two to seven decimals, no
 *  rounding. Null when the value is not a plain non-negative amount of at most seven decimals. */
export function formatLumensExact(lumens: string): string | null {
  const match = LUMENS.exec(lumens);
  if (!match) return null;
  const whole = BigInt(match[1]).toLocaleString("en-US");
  const fraction = (match[2] ?? "").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}
