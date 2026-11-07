import type { Network } from "@/config/networks";

/** Where a receipt saved in this browser is reopened. The page reads it from IndexedDB only. */
export function receiptPath(network: Network, id: string): string {
  return `/${network}/receipt/${encodeURIComponent(id)}`;
}
