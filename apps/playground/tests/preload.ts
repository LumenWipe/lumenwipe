import { plugin } from "bun";

/**
 * Stubs the `server-only` marker package for `bun test`.
 *
 * `server-only` is a build-time guard: its default export is a module that throws on import, and
 * only Next's `react-server` resolution condition swaps it for an empty one. That is exactly what
 * makes it useful in `lib/crypto.ts`, `lib/session-store.ts` and friends - a client component that
 * pulls in a custodial module fails the build instead of shipping it to the browser. Bun's test
 * runner resolves under no such condition, so without this every unit test that imports one of
 * those modules would die at import time on a guard that has nothing to say about tests.
 *
 * Registered via bunfig.toml's `[test] preload`, so it applies to the whole suite and no test has
 * to know about it.
 */
plugin({
  name: "server-only-stub",
  setup(build) {
    build.module("server-only", () => ({ contents: "export {};", loader: "js" }));
  },
});
