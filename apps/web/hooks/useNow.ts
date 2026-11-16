"use client";

import { useEffect, useState } from "react";

/**
 * The current time in ms, read after mount and again whenever `refresh` changes. Null on the
 * server and in the first client render, so prerendered markup never carries the build's date.
 */
export function useNow(refresh?: unknown): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, [refresh]);
  return now;
}
