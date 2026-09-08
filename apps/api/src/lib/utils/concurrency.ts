/** Runs `fn` over `items` with at most `concurrency` in flight, preserving input order in the
 *  result. Shared by the ledger-read fan-out in Soroban token discovery and allowance discovery -
 *  both read many contracts individually and need to bound how many RPC calls run at once. */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
