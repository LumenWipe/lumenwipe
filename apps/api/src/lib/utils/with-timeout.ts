/** Races `promise` against a bounded timeout; on timeout, rejects with `timeoutMessage` instead
 *  of leaving the caller waiting on a source that may never answer. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      timer.unref?.();
    }),
  ]);
}
