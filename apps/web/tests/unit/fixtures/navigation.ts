import { ReadonlyURLSearchParams, type useRouter } from "next/navigation";

type Router = ReturnType<typeof useRouter>;

/** A router whose navigations do nothing unless a test passes its own. */
export function fakeRouter(overrides: Partial<Router> = {}): Router {
  return {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    bfcacheId: "test",
    ...overrides,
  };
}

/** The search params `useSearchParams` hands a page for this query. */
export function searchParams(
  init: string | URLSearchParams | Record<string, string> = ""
): ReadonlyURLSearchParams {
  return new ReadonlyURLSearchParams(init);
}
