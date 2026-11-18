import { expect } from "bun:test";

// One demo's whole life through the playground's own routes, as the client drives it: create,
// every mess step, any allowance revokes, the close a round at a time, then cleanup. Shared by the
// manual integration tests; testnet only.

export const BASE_URL = process.env.PLAYGROUND_TEST_URL ?? "http://localhost:3002";

/** The client's limit on close rounds (hooks/usePlaygroundExecution.ts). */
const MAX_ROUNDS = 20;

const post = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE_URL}/api/session${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Runs a session created from `body` (a mode, a selection or a seed) to its merge. */
export async function runCycle(body: unknown): Promise<void> {
  const createRes = await post("", body);
  expect(createRes.ok).toBe(true);
  const session = (await createRes.json()) as {
    sessionId: string;
    demoPublic: string;
    messPlan: { id: string; action: { kind: string } }[];
  };
  expect(session.demoPublic).toMatch(/^G[A-Z0-9]{55}$/);
  const path = `/${session.sessionId}`;

  for (const step of session.messPlan) {
    const stepRes = await post(`${path}/mess`, { stepId: step.id });
    expect(stepRes.ok).toBe(true);
  }

  const stateAfterMess = await fetch(`${BASE_URL}/api/session${path}/state`);
  const messedState = (await stateAfterMess.json()) as {
    accountState: { signers: unknown[] } | null;
  };
  expect(messedState.accountState).not.toBeNull();

  if (session.messPlan.some((s) => s.action.kind === "approve_allowance")) {
    const listRes = await fetch(`${BASE_URL}/api/session${path}/allowances`);
    expect(listRes.ok).toBe(true);
    const { allowances } = (await listRes.json()) as { allowances: { spender: string }[] };
    for (const { spender } of allowances) {
      expect((await post(`${path}/allowances/revoke`, { spender })).ok).toBe(true);
    }
  }

  // One round per request, called again while the close is not done, as the client does.
  const confirmed: { hash: string }[] = [];
  let done = false;
  for (let round = 0; round < MAX_ROUNDS && !done; round++) {
    const roundRes = await post(`${path}/demolish/round`);
    expect(roundRes.ok).toBe(true);
    const result = (await roundRes.json()) as { done: boolean; confirmed: { hash: string }[] };
    confirmed.push(...result.confirmed);
    done = result.done;
  }
  expect(done).toBe(true);
  expect(confirmed.length).toBeGreaterThan(0);

  const stateAfterDemolish = await fetch(`${BASE_URL}/api/session${path}/state`);
  const finalState = (await stateAfterDemolish.json()) as { accountState: unknown | null };
  expect(finalState.accountState).toBeNull(); // account merged away

  expect((await post(`${path}/cleanup`)).ok).toBe(true);
}
