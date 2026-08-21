import { test, expect } from "bun:test";

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

const BASE_URL = process.env.PLAYGROUND_TEST_URL ?? "http://localhost:3002";

test.skipIf(!RUN_INTEGRATION)(
  "full cycle: create session, mess, demolish, cleanup",
  async () => {
    const createRes = await fetch(`${BASE_URL}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "light" }),
    });
    expect(createRes.ok).toBe(true);
    const session = (await createRes.json()) as {
      sessionId: string;
      demoPublic: string;
      messPlan: { id: string }[];
    };
    expect(session.demoPublic).toMatch(/^G[A-Z0-9]{55}$/);

    for (const step of session.messPlan) {
      const stepRes = await fetch(`${BASE_URL}/api/session/${session.sessionId}/mess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stepId: step.id }),
      });
      expect(stepRes.ok).toBe(true);
    }

    const stateAfterMess = await fetch(`${BASE_URL}/api/session/${session.sessionId}/state`);
    const messedState = (await stateAfterMess.json()) as {
      accountState: { signers: unknown[] } | null;
    };
    expect(messedState.accountState).not.toBeNull();

    const demolishRes = await fetch(`${BASE_URL}/api/session/${session.sessionId}/demolish`, {
      method: "POST",
    });
    expect(demolishRes.ok).toBe(true);
    const demolishResult = (await demolishRes.json()) as { done: boolean };
    expect(demolishResult.done).toBe(true);

    const stateAfterDemolish = await fetch(`${BASE_URL}/api/session/${session.sessionId}/state`);
    const finalState = (await stateAfterDemolish.json()) as { accountState: unknown | null };
    expect(finalState.accountState).toBeNull(); // account merged away

    const cleanupRes = await fetch(`${BASE_URL}/api/session/${session.sessionId}/cleanup`, {
      method: "POST",
    });
    expect(cleanupRes.ok).toBe(true);
  },
  180_000 // full cycle against real testnet can take a couple of minutes
);
