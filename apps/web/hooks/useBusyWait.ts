import { useCallback, useEffect, useRef, useState } from "react";

export interface BusyWait {
  /** The longest wait still running, in seconds, or null when nothing waits. */
  seconds: number | null;
  /** A reporter for one call's wait, to pass as `onWait`. */
  reporter: () => (seconds: number | null) => void;
  /** The signal the waits started now listen to for the user's stop. */
  stopSignal: () => AbortSignal;
  /** Ends every running wait. */
  stop: () => void;
}

/** The automatic waits a page runs after busy answers, shown as one notice the user can stop.
 *  Leaving the page stops them too. */
export function useBusyWait(): BusyWait {
  const [seconds, setSeconds] = useState<number | null>(null);
  const waits = useRef(new Map<number, number>());
  const nextId = useRef(0);
  const stopper = useRef(new AbortController());

  const reporter = useCallback(() => {
    const id = nextId.current++;
    return (wait: number | null): void => {
      if (wait === null) waits.current.delete(id);
      else waits.current.set(id, wait);
      setSeconds(waits.current.size === 0 ? null : Math.max(...waits.current.values()));
    };
  }, []);
  const stopSignal = useCallback(() => stopper.current.signal, []);
  const stop = useCallback(() => {
    stopper.current.abort();
    stopper.current = new AbortController();
  }, []);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Strict Mode mounts again at once; only a page that stays unmounted ends its waits.
      setTimeout(() => {
        if (!mounted.current) stopper.current.abort();
      }, 0);
    };
  }, []);

  return { seconds, reporter, stopSignal, stop };
}
