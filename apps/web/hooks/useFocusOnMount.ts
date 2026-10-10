import { useEffect, useRef, type RefObject } from "react";

/** The target needs tabIndex={-1}: it is focused by script, never reachable by Tab. */
export function useFocusOnMount<T extends HTMLElement>(
  active: boolean = true
): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) ref.current?.focus();
  }, [active]);
  return ref;
}
