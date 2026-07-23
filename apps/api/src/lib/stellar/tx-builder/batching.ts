import { OP_BATCH_LIMIT } from "@/config/constants";

export function batchItems<T>(items: T[], limit = OP_BATCH_LIMIT): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += limit) {
    batches.push(items.slice(i, i + limit));
  }
  return batches;
}
