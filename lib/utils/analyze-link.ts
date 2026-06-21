import type { Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";

/**
 * Builds the analyze-flow href for a pasted account, or null when the address
 * is not a valid G-address. Whitespace is trimmed so pasted values with stray
 * spaces still resolve. Callers gate navigation on a non-null result.
 */
export function buildAnalyzeHref(network: Network, source: string): string | null {
  const trimmed = source.trim();
  if (!isValidGAddress(trimmed)) return null;
  return `/${network}/analyze?source=${encodeURIComponent(trimmed)}`;
}
