import type { ComponentType } from "react";
import { UserFacingError } from "@/lib/utils/user-error";
import type { PollarSignInProps } from "./PollarSignIn";

export type PollarSignInComponent = ComponentType<PollarSignInProps>;

export const POLLAR_LOAD_FAILED =
  "Google, GitHub and email sign-in could not load. Check your connection and try again.";

/** The Pollar sign-in code could not be loaded. */
export class PollarLoadError extends UserFacingError {
  constructor(readonly reason?: unknown) {
    super(POLLAR_LOAD_FAILED);
    this.name = "PollarLoadError";
  }
}

/** The one place Pollar's code is fetched: never at page load, only once the visitor wants it. */
export function importPollarSignIn(): Promise<PollarSignInComponent> {
  return import("./PollarSignIn").then((module) => module.default);
}

/** Loads the sign-in once and shares that load with every caller; a failed load is not kept. */
export function pollarSignInLoader(
  importSignIn: () => Promise<PollarSignInComponent>
): () => Promise<PollarSignInComponent> {
  let loading: Promise<PollarSignInComponent> | null = null;
  return () => {
    if (loading) return loading;
    const attempt = Promise.resolve()
      .then(importSignIn)
      .catch((cause: unknown) => {
        if (loading === attempt) loading = null;
        throw new PollarLoadError(cause);
      });
    loading = attempt;
    return attempt;
  };
}

export const loadPollarSignIn = pollarSignInLoader(importPollarSignIn);

const STORAGE_PREFIX = "pollar:";
const SESSION_SUFFIX = ":session";

/** Whether Pollar saved a session in this browser, the only case its sign-in restores on load. */
export function hasStoredPollarSession(): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX) || !key.endsWith(SESSION_SUFFIX)) continue;
      if (storage.getItem(key)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
