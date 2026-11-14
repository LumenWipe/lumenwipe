const SV_EXPLORER_TESTNET = "https://stellarview.acachete.xyz/en/testnet";

/** A testnet transaction's page in the explorer. */
export function txExplorerUrl(hash: string): string {
  return `${SV_EXPLORER_TESTNET}/tx/${hash}`;
}
