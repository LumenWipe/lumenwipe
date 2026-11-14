"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaygroundStore } from "@/store/playground";
import { PlaygroundApiError, playgroundRequest } from "@/lib/playground-api";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";

/** The extension is offered this close to the end, the same window the server accepts it in. */
export const EXTENSION_WINDOW_SECONDS = 300;

/** How often a busy session is asked again: a batch member's setup step can hold its lock. */
const EXTEND_ATTEMPTS = 3;
const EXTEND_RETRY_MS = 1500;

export interface SessionCountdown {
  /** Whole seconds left, or null with no session. */
  remaining: number | null;
  /** Inside the last five minutes, before the end. */
  warning: boolean;
  timeUp: boolean;
  extended: boolean;
  extending: boolean;
  extendError: string | null;
  extend: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The session's countdown, ticking every second, and its one extension. */
export function useSessionCountdown(): SessionCountdown {
  const expiresAt = usePlaygroundStore((s) => s.expiresAt);
  const extended = usePlaygroundStore((s) => s.extended);
  const [now, setNow] = useState(() => Date.now());
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);

  useEffect(() => {
    if (expiresAt === null) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [expiresAt]);

  const extend = useCallback(async () => {
    const { sessionId, batch } = usePlaygroundStore.getState();
    const path = batch ? `/batch/${batch.batchId}/extend` : `/session/${sessionId}/extend`;
    if ((!batch && !sessionId) || extending) return;
    setExtending(true);
    setExtendError(null);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          const body = await playgroundRequest<{ expiresAt: number }>(fetch, path, {
            method: "POST",
          });
          usePlaygroundStore.getState().setExpiry(body.expiresAt, true);
          return;
        } catch (err) {
          const busy = err instanceof PlaygroundApiError && err.code === "step_in_progress";
          if (!busy || attempt === EXTEND_ATTEMPTS) throw err;
          await sleep(EXTEND_RETRY_MS);
        }
      }
    } catch (err) {
      setExtendError(err instanceof PlaygroundApiError ? err.message : GENERIC_ERROR_COPY);
    } finally {
      setExtending(false);
    }
  }, [extending]);

  const remaining = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return {
    remaining,
    warning: remaining !== null && remaining > 0 && remaining <= EXTENSION_WINDOW_SECONDS,
    timeUp: remaining === 0,
    extended,
    extending,
    extendError,
    extend: () => void extend(),
  };
}
