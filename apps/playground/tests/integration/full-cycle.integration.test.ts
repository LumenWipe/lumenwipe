import { test } from "bun:test";
import { runCycle } from "./cycle";

// Manual only: `bun run --filter '@lumenwipe/playground' test:integration`.
// Requires: apps/playground running locally (bun run dev:playground) against a
// live apps/api instance with a "playground" API_KEYS label, and real testnet
// Friendbot/Horizon access.
//
// Gated the same way apps/api/tests/integration/*.test.ts is: `bun test` with no
// path argument walks every *.test.ts file it finds, so the env check has to live
// inside the test itself (skipIf), not just in the package.json script that scopes
// the path - otherwise a bare `bun test` in this package would attempt real network
// calls with no API/playground running.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "full cycle: create session, mess, demolish, cleanup",
  () => runCycle({ mode: "light" }),
  180_000 // full cycle against real testnet can take a couple of minutes
);
