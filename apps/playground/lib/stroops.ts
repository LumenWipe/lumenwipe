// Exact XLM amounts as integers, shared by the verifier and the executors without either
// importing the other.

const STROOPS_PER_UNIT = BigInt(10_000_000);

/** A decimal amount as the SDK prints one (at most seven decimals), in stroops; null otherwise. */
export function parseStroops(amount: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return BigInt(whole!) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, "0"));
}

/** The amount string a payment operation takes, from a non-negative stroop count. */
export function formatStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

/** Like parseStroops, for an amount the network itself reported. */
export function networkStroops(amount: string): bigint {
  const stroops = parseStroops(amount);
  if (stroops === null) throw new Error("The network reported an unreadable amount");
  return stroops;
}
