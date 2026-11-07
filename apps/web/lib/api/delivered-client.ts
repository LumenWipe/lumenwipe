import type { Network } from "@/config/networks";
import { readApiError } from "@/lib/utils/user-error";

/**
 * Asks the proxy what the given confirmed transactions delivered to `destination`. Returns the
 * body as received, unchecked: `readReceived` decides what it may be trusted to say. Throws when
 * the lookup itself failed. Display only: nothing read here feeds a check or a signature.
 */
export async function fetchCloseDelivered(
  network: Network,
  destination: string,
  hashes: readonly string[]
): Promise<unknown> {
  const query = new URLSearchParams({ destination, hashes: hashes.join(",") });
  const res = await fetch(`/api/v1/${network}/close/delivered?${query.toString()}`);
  if (!res.ok) throw await readApiError(res);
  return (await res.json()) as unknown;
}
