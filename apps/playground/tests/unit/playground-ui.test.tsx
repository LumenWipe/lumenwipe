import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createHash } from "node:crypto";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { IntentOperation } from "@lumenwipe/sdk";
import { blockerCopy, credentialsErrorCopy, errorCopy } from "@/lib/error-copy";
import { getMessPlanForMode } from "@/lib/mess-plan";
import {
  BLOCKED_MEMBER_SELECTION,
  DEFAULT_BATCH_MEMBERS,
  LIGHT_SELECTION,
  SCENARIOS,
  STANDARD_SELECTION,
  decodeSelection,
  encodeSelection,
  generateRandomSelection,
  parseReplayCode,
  resolvePlan,
  willCreate,
} from "@/lib/scenarios";
import { usePlaygroundStore, type PlaygroundPhase } from "@/store/playground";
import { usePlaygroundExecution } from "@/hooks/usePlaygroundExecution";
import { buildSceneNode } from "@/lib/scene-model";
import { useBatchExecution } from "@/hooks/useBatchExecution";
import BatchPanel from "@/components/scene/BatchPanel";
import PlaygroundControls from "@/components/scene/PlaygroundControls";
import TxLogPanel from "@/components/scene/TxLogPanel";
import SdkSnippetPanel from "@/components/scene/SdkSnippetPanel";
import ScenarioPicker from "@/components/scene/ScenarioPicker";
import OrbitalScene from "@/components/scene/OrbitalScene";
import PlaygroundClient from "@/app/PlaygroundClient";
import { TIME_UP_COPY, WARNING_COPY } from "@/components/scene/SessionCountdown";
import { tick } from "./session-fixtures";

// The playground as the visitor sees it. The scenario picker: presets, toggles, the live totals
// and the step list, and how the scene draws what it is given. The demolish: the hook, the control
// panel and the activity log, against a fake of the playground's own routes. Each round's confirmed transactions must reach the scene
// and the log as that round returns, and an error part way through must offer a resume, with a
// warning before "Start over" abandons the account.

// The DOM is registered for this file only, and removed after it, so the rest of the suite keeps
// Bun's own globals. @testing-library/react reads `document` when it loads, hence the dynamic
// import after registering.
// A real origin, so a test can put a shared link in the address bar with history.replaceState.
GlobalRegistrator.register({ url: "http://localhost:3002/" });
// happy-dom's Web Animations reject a cancelled animation's `finished` promise, which nothing in
// motion/react awaits, so a scene node leaving mid-animation fails the run. Without `animate`,
// motion animates in JS on its own frame loop instead.
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
delete (Element.prototype as { animate?: unknown }).animate;
const rtl = await import("@testing-library/react");
afterAll(async () => {
  if (nativeAnimate) Object.defineProperty(Element.prototype, "animate", nativeAnimate);
  await GlobalRegistrator.unregister();
});

const SESSION_ID = "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01";
/** The account fields the control panel reads, for a demo with only its master key. */
const ACCOUNT_SHAPE = {
  numSponsoring: 0,
  signers: [{ type: "ed25519_public_key", key: "GDEMO", weight: 1 }],
  thresholds: { low: 0, med: 0, high: 0 },
  openOffers: [],
};
const ISSUER = "GISSUER";
const EXPLORER_TX = "https://stellarview.acachete.xyz/en/testnet/tx/";

const op = (body: IntentOperation): IntentOperation => body;
const REMOVE_TRUSTLINE = {
  txId: "tx-1",
  hash: "a".repeat(64),
  summary: "Remove the LWDEMO trustline",
  operations: [
    op({ type: "change_trust", asset: `LWDEMO:${ISSUER}`, limit: "0", source: "GDEMO" }),
  ],
};
const MERGE = {
  txId: "tx-2",
  hash: "b".repeat(64),
  summary: "Close the account",
  operations: [op({ type: "account_merge", destination: "GSINK", source: "GDEMO" })],
};

type Handler = (method: string) => Promise<{ status: number; body: unknown }>;

/** A fake of the playground routes, by path. A test replaces the handlers it cares about. */
class FakeRoutes {
  readonly calls: string[] = [];
  readonly bodies: string[] = [];
  handlers = new Map<string, Handler>([
    [
      "/api/session",
      async () => ({
        status: 200,
        body: {
          sessionId: SESSION_ID,
          demoPublic: "GDEMO",
          expiresAt: Date.now() + 3_600_000,
          messPlan: getMessPlanForMode("light"),
          accounts: { issuer: ISSUER, mm: "GSINK", lwdemoAsset: `LWDEMO:${ISSUER}`, ephemeral: [] },
        },
      }),
    ],
    [
      `/api/session/${SESSION_ID}/mess`,
      async () => ({ status: 200, body: { txHash: "c".repeat(64) } }),
    ],
    [`/api/session/${SESSION_ID}/state`, async () => ({ status: 200, body: this.state })],
    [`/api/session/${SESSION_ID}/cleanup`, async () => ({ status: 200, body: { ok: true } })],
  ]);
  state: Record<string, unknown> = {
    demoPublic: "GDEMO",
    accountState: { ...ACCOUNT_SHAPE, nativeBalanceLumens: "9999.5", numSubEntries: 1 },
    completedMessSteps: [],
    demolishLog: [],
    demolishDone: false,
  };

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${path}`);
    if (typeof init?.body === "string") this.bodies.push(init.body);
    const handler = this.handlers.get(path);
    const { status, body } = handler ? await handler(method) : { status: 404, body: {} };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };

  count(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
}

const ROUND = `/api/session/${SESSION_ID}/demolish/round`;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function Harness() {
  const { start, demolish, resolve, progressStatus } = usePlaygroundExecution();
  const batchRun = useBatchExecution();
  return (
    <>
      <BatchPanel onResolve={batchRun.resolveMember} />
      <PlaygroundControls
        start={start}
        demolish={demolish}
        resolve={resolve}
        startBatch={batchRun.startBatch}
        closeBatch={batchRun.closeBatch}
        progressStatus={batchRun.progressStatus ?? progressStatus}
      />
      <TxLogPanel />
      <span hidden data-run-idle={String((batchRun.progressStatus ?? progressStatus) === null)} />
    </>
  );
}

let routes: FakeRoutes;
let originalFetch: typeof fetch;

beforeEach(() => {
  routes = new FakeRoutes();
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(routes.fetch, { preconnect: originalFetch.preconnect });
  usePlaygroundStore.getState().reset();
  usePlaygroundStore.getState().setBatchSize(0);
  // The picked scenarios survive reset by design; each test starts from the classic preset.
  usePlaygroundStore.getState().setSelection(resolvePlan(STANDARD_SELECTION).selection, "classic");
});

// A run keeps going after the screen a test waits for: its `finally`, the state read and the best
// effort snippet fetch land a few ticks later. They are let finish inside act, so React has no
// work left scheduled when the DOM is unmounted and, after the last test, unregistered.
afterEach(async () => {
  await rtl.waitFor(() => expect(document.querySelector('[data-run-idle="false"]')).toBeNull());
  await rtl.act(tick);
  rtl.cleanup();
  globalThis.fetch = originalFetch;
});

/** What the polite status region holds now. */
const liveStatus = () => document.querySelector('[role="status"][aria-live="polite"]')?.textContent;
const trustlineNode = () => usePlaygroundStore.getState().nodes.find((n) => n.id === "tl:LWDEMO");
const txLink = (hash: string) =>
  rtl.screen.queryAllByRole("link").filter((a) => a.getAttribute("href") === EXPLORER_TX + hash);

/** Renders the harness and runs the light mess until the panel offers the demolish. */
async function dirtyAccount(): Promise<void> {
  rtl.render(<Harness />);
  rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
  await rtl.screen.findByRole("button", { name: /Demolish it here/ }, { timeout: 5000 });
  expect(trustlineNode()?.status).toBe("docked");
}

describe("a batch close", () => {
  const BATCH_ID = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
  const MEMBER_IDS = [
    "1a2b3c4d-1111-4222-8333-444455556666",
    "1a2b3c4d-2222-4333-8444-555566667777",
    "1a2b3c4d-3333-4444-8555-666677778888",
  ];
  const BLOCKER = "sponsorship_claimable_balance_unrevocable";
  const lightPlan = resolvePlan(LIGHT_SELECTION).steps;
  const blockedPlan = resolvePlan(BLOCKED_MEMBER_SELECTION).steps;

  function batchRoutes(size: 2 | 3): void {
    const ids = MEMBER_IDS.slice(0, size);
    const blockedId = ids[size - 1]!;
    routes.handlers.set("/api/batch", async () => ({
      status: 200,
      body: {
        batchId: BATCH_ID,
        blockedIndex: size - 1,
        expiresAt: Date.now() + 3_600_000,
        members: ids.map((sessionId, i) => ({
          sessionId,
          demoPublic: `GDEMO${i + 1}`,
          expiresAt: Date.now() + 3_600_000,
          messPlan: i === size - 1 ? blockedPlan : lightPlan,
          accounts: { issuer: ISSUER, mm: "GSINK", lwdemoAsset: `LWDEMO:${ISSUER}`, ephemeral: [] },
          label: i === size - 1 ? "Claimable balances" : "Demo token holding",
        })),
      },
    }));
    routes.handlers.set(`/api/batch/${BATCH_ID}/plan`, async () => ({
      status: 200,
      body: {
        results: ids.map((_, i) => ({
          index: i,
          address: `GDEMO${i + 1}`,
          status: i === size - 1 ? "blocked" : "needs_decisions",
          blockers: i === size - 1 ? [{ code: BLOCKER, message: "api text" }] : [],
          estimatedTransactionCount: 1,
        })),
      },
    }));
    let resolved = false;
    for (const id of ids) {
      routes.handlers.set(`/api/session/${id}/mess`, async () => ({
        status: 200,
        body: { txHash: "c".repeat(64) },
      }));
      routes.handlers.set(`/api/session/${id}/cleanup`, async () => ({
        status: 200,
        body: { ok: true },
      }));
      routes.handlers.set(`/api/session/${id}/demolish/round`, async () =>
        id === blockedId && !resolved
          ? {
              status: 422,
              body: { error: "demolish_blocked", blockers: [BLOCKER], resolvable: [BLOCKER] },
            }
          : { status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: null } }
      );
    }
    routes.handlers.set(`/api/session/${blockedId}/resolve`, async () => {
      resolved = true;
      return { status: 200, body: { ok: true } };
    });
  }

  async function plannedBatch(size: 2 | 3): Promise<void> {
    batchRoutes(size);
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: `A batch of ${size}` }));
    rtl.fireEvent.click(
      rtl.screen.getByRole("button", { name: `Create & trash ${size} demo accounts` })
    );
    await rtl.screen.findByRole("button", { name: "Close every account" }, { timeout: 5000 });
  }

  test("creates the batch with the default accounts, runs each mess, then plans them in one call", async () => {
    await plannedBatch(3);
    expect(JSON.parse(routes.bodies[0]!)).toEqual({ members: DEFAULT_BATCH_MEMBERS[3] });
    for (const id of MEMBER_IDS) {
      expect(routes.calls.filter((c) => c === `POST /api/session/${id}/mess`).length).toBe(
        id === MEMBER_IDS[2] ? blockedPlan.length : lightPlan.length
      );
    }
    expect(routes.count(`GET /api/batch/${BATCH_ID}/plan`)).toBe(1);
    const blocked = rtl.screen.getByRole("listitem", { name: "Account 3" });
    expect(blocked.textContent).toContain("blocked on purpose");
    expect(blocked.textContent).toContain(blockerCopy(BLOCKER));
    expect(rtl.screen.getByRole("listitem", { name: "Account 1" }).textContent).toContain(
      "Ready once the playground answers its questions"
    );
  });

  test("closes every account in turn, reports the blocked one, and resolving it closes it too", async () => {
    await plannedBatch(3);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "Close every account" }));
    await rtl.screen.findByText(
      /Batch complete: 2 of 3 accounts merged away, 1 reported/,
      undefined,
      {
        timeout: 5000,
      }
    );
    const rounds = routes.calls.filter((c) => c.endsWith("/demolish/round"));
    expect(rounds).toEqual(MEMBER_IDS.map((id) => `POST /api/session/${id}/demolish/round`));
    expect(routes.count(`POST /api/session/${MEMBER_IDS[2]}/cleanup`)).toBe(0);
    const blocked = rtl.screen.getByRole("listitem", { name: "Account 3" });
    expect(blocked.textContent).toContain("Not closed: blocked");

    rtl.fireEvent.click(rtl.within(blocked).getByRole("button", { name: "Resolve it" }));
    await rtl.waitFor(() =>
      expect(usePlaygroundStore.getState().batch?.members[2]?.close).toBe("closed")
    );
    expect(routes.count(`POST /api/session/${MEMBER_IDS[2]}/resolve`)).toBe(1);
    expect(routes.count(`POST /api/session/${MEMBER_IDS[2]}/cleanup`)).toBe(1);
  });

  test("a batch plan that cannot be read still leaves every account to close", async () => {
    batchRoutes(3);
    routes.handlers.set(`/api/batch/${BATCH_ID}/plan`, async () => ({
      status: 502,
      body: { error: "batch_plan_failed" },
    }));
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "A batch of 3" }));
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "Create & trash 3 demo accounts" }));
    await rtl.screen.findByRole("button", { name: "Close every account" }, { timeout: 5000 });
    expect(usePlaygroundStore.getState().phase).toBe("DIRTY");
    expect(
      rtl.screen.getByText(
        "The batch plan could not be read, but every account can still be closed."
      )
    ).toBeTruthy();
    for (const n of [1, 2, 3]) {
      expect(rtl.screen.getByRole("listitem", { name: `Account ${n}` }).textContent).toContain(
        "Could not be read"
      );
    }

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "Close every account" }));
    await rtl.screen.findByText(/Batch complete: 2 of 3 accounts merged away/, undefined, {
      timeout: 5000,
    });
    expect(routes.calls.filter((c) => c.endsWith("/demolish/round"))).toEqual(
      MEMBER_IDS.map((id) => `POST /api/session/${id}/demolish/round`)
    );
  });

  test("a batch link opens on a batch of that size", async () => {
    window.history.replaceState(null, "", "/?batch=2");
    try {
      rtl.render(<PlaygroundClient />);
      await rtl.waitFor(() => expect(usePlaygroundStore.getState().batchSize).toBe(2));
      expect(rtl.screen.getByRole("button", { name: "A batch of 2", pressed: true })).toBeTruthy();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("allowances are revoked before the close", () => {
  const ALLOWANCES = `/api/session/${SESSION_ID}/allowances`;
  const REVOKE = `/api/session/${SESSION_ID}/allowances/revoke`;
  const spenders = ["GSPENDERONE", "GSPENDERTWO"];
  const hashOf = (spender: string) => (spender === spenders[0] ? "d" : "e").repeat(64);

  async function allowanceAccount(): Promise<void> {
    const plan = resolvePlan({ scenarios: [{ id: "allowances", params: { spenders: 2 } }] });
    routes.handlers.set("/api/session", async () => ({
      status: 200,
      body: {
        sessionId: SESSION_ID,
        demoPublic: "GDEMO",
        expiresAt: Date.now() + 3_600_000,
        messPlan: plan.steps,
        accounts: { issuer: ISSUER, mm: "GSINK", lwdemoAsset: `LWDEMO:${ISSUER}`, ephemeral: [] },
      },
    }));
    routes.handlers.set(ALLOWANCES, async () => ({
      status: 200,
      body: {
        // The API's best-effort list missed the second: it is revoked all the same.
        allowances: spenders.map((spender, i) => ({
          index: i + 1,
          token: "CXLM",
          spender,
          listed: i === 0,
          amount: i === 0 ? "1" : null,
        })),
      },
    }));
    routes.handlers.set(REVOKE, async () => {
      const { spender } = JSON.parse(routes.bodies[routes.bodies.length - 1]!) as {
        spender: string;
      };
      return { status: 200, body: { spender, txHash: hashOf(spender) } };
    });
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    await rtl.screen.findByRole("button", { name: /Demolish it here/ }, { timeout: 5000 });
  }
  const allowanceNodes = () =>
    usePlaygroundStore
      .getState()
      .nodes.filter((n) => n.kind === "allowance")
      .map((n) => [n.id, n.status, n.balance]);

  test("each recorded allowance is revoked, shown and logged, then the close runs", async () => {
    routes.handlers.set(ROUND, async () => ({
      status: 200,
      body: { done: true, confirmed: [MERGE], remainingSteps: 0 },
    }));
    await allowanceAccount();
    expect(allowanceNodes()).toEqual([
      ["allowance:1", "docked", "10"],
      ["allowance:2", "docked", "25"],
    ]);

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });

    const demolishCalls = routes.calls.slice(routes.calls.indexOf(`GET ${ALLOWANCES}`));
    expect(demolishCalls.slice(0, 5)).toEqual([
      `GET ${ALLOWANCES}`,
      `POST ${REVOKE}`,
      `POST ${REVOKE}`,
      `GET /api/session/${SESSION_ID}/state`,
      `POST ${ROUND}`,
    ]);
    expect(routes.bodies.slice(-2)).toEqual(spenders.map((spender) => JSON.stringify({ spender })));
    for (const spender of spenders) expect(txLink(hashOf(spender))).toHaveLength(1);
    expect(rtl.screen.getByText("Revoke spender 1's allowance")).toBeTruthy();
    expect(
      rtl.screen.getByText("The API lists 1 of the 2 allowances this demo approved")
    ).toBeTruthy();
    expect(allowanceNodes().map(([id, status]) => [id, status])).toEqual([
      ["allowance:1", "destroyed"],
      ["allowance:2", "destroyed"],
    ]);
  });

  test("a refused revoke stops before the close, and the resume lists them again", async () => {
    let refuse = true;
    routes.handlers.set(ROUND, async () => ({
      status: 200,
      body: { done: true, confirmed: [MERGE], remainingSteps: 0 },
    }));
    await allowanceAccount();
    const revoke = routes.handlers.get(REVOKE)!;
    routes.handlers.set(REVOKE, async (method) =>
      refuse ? { status: 422, body: { error: "revoke_refused" } } : revoke(method)
    );
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    const alert = await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert.textContent).toBe(errorCopy("revoke_refused"));
    expect(routes.count(`POST ${ROUND}`)).toBe(0);

    refuse = false;
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Resume the close/ }));
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(routes.count(`GET ${ALLOWANCES}`)).toBe(2);
    expect(routes.count(`POST ${ROUND}`)).toBe(1);
  });

  test("a close that fails after the revokes resumes without listing them again", async () => {
    let rounds = 0;
    routes.handlers.set(ROUND, async () => {
      rounds++;
      return rounds === 1
        ? { status: 502, body: { error: "demolish_failed" } }
        : { status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: 0 } };
    });
    await allowanceAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    await rtl.screen.findByRole("button", { name: /Resume the close/ }, { timeout: 5000 });
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Resume the close/ }));
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(routes.count(`GET ${ALLOWANCES}`)).toBe(1);
    expect(routes.count(`POST ${REVOKE}`)).toBe(2);
  });

  test("a session with no allowance step never asks for the list", async () => {
    routes.handlers.set(ROUND, async () => ({
      status: 200,
      body: { done: true, confirmed: [MERGE], remainingSteps: 0 },
    }));
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(routes.count(`GET ${ALLOWANCES}`)).toBe(0);
  });
});

test("a mess step that sent nothing is logged without a transaction link", async () => {
  const hashOf = (stepId: string): string | null =>
    stepId === "SETUP" ? null : createHash("sha256").update(stepId).digest("hex");
  routes.handlers.set(`/api/session/${SESSION_ID}/mess`, async () => {
    const { stepId } = JSON.parse(routes.bodies[routes.bodies.length - 1]!) as { stepId: string };
    return { status: 200, body: { stepId, txHash: hashOf(stepId) } };
  });
  await dirtyAccount();

  const log = usePlaygroundStore.getState().log;
  const setup = log.find((e) => e.label === getMessPlanForMode("light")[0]!.label);
  expect(setup).toMatchObject({ txHash: null, kind: "info" });
  for (const step of getMessPlanForMode("light").slice(1)) {
    expect(log.find((e) => e.label === step.label)).toMatchObject({
      txHash: hashOf(step.id),
      kind: "mess",
    });
    expect(txLink(hashOf(step.id)!)).toHaveLength(1);
  }
  expect(rtl.screen.queryAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(
    getMessPlanForMode("light")
      .slice(1)
      .map((s) => EXPLORER_TX + hashOf(s.id))
      .reverse()
  );
});

describe("the session's SDK code", () => {
  const SNIPPET_ROUTE = `/api/session/${SESSION_ID}/sdk-snippet`;

  test("is fetched once the mess is done, and kept through the close", async () => {
    routes.handlers.set(SNIPPET_ROUTE, async () => ({
      status: 200,
      body: { snippet: "await runClose({});" },
    }));
    await dirtyAccount();
    await rtl.waitFor(() =>
      expect(usePlaygroundStore.getState().sdkSnippet).toBe("await runClose({});")
    );
    expect(routes.count(`GET ${SNIPPET_ROUTE}`)).toBe(1);
  });

  test("an answer that arrives after the session ended is dropped", async () => {
    const answer = deferred<{ status: number; body: unknown }>();
    routes.handlers.set(SNIPPET_ROUTE, () => answer.promise);
    await dirtyAccount();
    await rtl.waitFor(() => expect(routes.count(`GET ${SNIPPET_ROUTE}`)).toBe(1));
    rtl.act(() => usePlaygroundStore.getState().reset());
    answer.resolve({ status: 200, body: { snippet: "await runClose({});" } });
    await tick();
    expect(usePlaygroundStore.getState().sdkSnippet).toBeNull();
  });

  test("a failed fetch leaves the run as it was, with no code", async () => {
    routes.handlers.set(SNIPPET_ROUTE, async () => ({
      status: 500,
      body: { error: "snippet_unavailable" },
    }));
    await dirtyAccount();
    await rtl.waitFor(() => expect(routes.count(`GET ${SNIPPET_ROUTE}`)).toBe(1));
    expect(usePlaygroundStore.getState().phase).toBe("DIRTY");
    expect(usePlaygroundStore.getState().sdkSnippet).toBeNull();
  });
});

describe("the SDK code panel", () => {
  const SNIPPET = 'import { LumenWipeClient } from "@lumenwipe/sdk";\nconst source = "GDEMO";';
  let copied: string[];

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });

  function show(phase: PlaygroundPhase, snippet: string | null = SNIPPET): void {
    const store = usePlaygroundStore.getState();
    store.setPhase(phase);
    if (snippet !== null) store.setSdkSnippet(snippet);
    rtl.render(<SdkSnippetPanel />);
  }

  test("before the close, it shows the same close in code", () => {
    show("DIRTY");
    expect(rtl.screen.getByRole("region", { name: "The same close in code" })).toBeTruthy();
    expect(rtl.screen.getByLabelText("SDK code for this close").textContent).toBe(SNIPPET);
  });

  test("after the close, it names the close that ran", () => {
    show("COMPLETE");
    expect(rtl.screen.getByRole("region", { name: "This close with the SDK" })).toBeTruthy();
  });

  test("the copy button copies the snippet and says so", async () => {
    show("DIRTY");
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "Copy the SDK code" }));
    await rtl.screen.findByText("Copied to the clipboard");
    expect(copied).toEqual([SNIPPET]);
    expect(rtl.screen.getByRole("status").textContent).toBe("Copied to the clipboard");
  });

  test("nothing is shown without a snippet, or before the mess is done", () => {
    show("DIRTY", null);
    expect(rtl.screen.queryByRole("region")).toBeNull();
    rtl.cleanup();
    for (const phase of ["IDLE", "MESSING", "EXPIRED"] as const) {
      show(phase);
      expect(rtl.screen.queryByRole("region")).toBeNull();
      rtl.cleanup();
    }
  });

  test("a new session clears the last session's snippet", () => {
    usePlaygroundStore.getState().setSdkSnippet(SNIPPET);
    usePlaygroundStore.getState().reset();
    expect(usePlaygroundStore.getState().sdkSnippet).toBeNull();
  });
});

describe("the demolish runs round by round", () => {
  test("each round's confirmed transaction reaches the scene and the log as it returns", async () => {
    const second = deferred<{ status: number; body: unknown }>();
    let rounds = 0;
    routes.handlers.set(ROUND, async () => {
      rounds++;
      if (rounds === 1) {
        return {
          status: 200,
          body: { done: false, confirmed: [REMOVE_TRUSTLINE], remainingSteps: 1 },
        };
      }
      return second.promise;
    });
    await dirtyAccount();

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));

    // Round 1 has returned and round 2 is still running: its transaction is already shown.
    await rtl.waitFor(() => expect(txLink(REMOVE_TRUSTLINE.hash)).toHaveLength(1), {
      timeout: 5000,
    });
    expect(trustlineNode()?.status).toBe("destroyed");
    expect(rtl.screen.getByText(REMOVE_TRUSTLINE.summary)).toBeTruthy();
    // Shown once on screen, and announced once in the polite status region.
    expect(
      rtl.screen.getByText("Closing the account, round 2 of about 2...", { ignore: ".sr-only" })
    ).toBeTruthy();
    await rtl.waitFor(() =>
      expect(liveStatus()).toBe("Closing the account, round 2 of about 2...")
    );
    expect(usePlaygroundStore.getState().phase).toBe("DEMOLISHING");

    second.resolve({ status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: 0 } });
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(txLink(MERGE.hash)).toHaveLength(1);
    expect(txLink(REMOVE_TRUSTLINE.hash)).toHaveLength(1);
    expect(routes.count(`POST ${ROUND}`)).toBe(2);
    expect(routes.count(`POST /api/session/${SESSION_ID}/cleanup`)).toBe(1);
  });

  test("an error part way offers a resume, which carries on without replaying", async () => {
    let rounds = 0;
    routes.handlers.set(ROUND, async () => {
      rounds++;
      if (rounds === 1) {
        // What the failed round confirmed before it stopped is in the session log.
        routes.state = {
          ...routes.state,
          accountState: { ...ACCOUNT_SHAPE, nativeBalanceLumens: "9999.0", numSubEntries: 0 },
          demolishLog: [REMOVE_TRUSTLINE],
        };
        return { status: 502, body: { error: "demolish_outcome_unknown" } };
      }
      return { status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: 0 } };
    });
    await dirtyAccount();

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));

    const alert = await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert.textContent).toBe(errorCopy("demolish_outcome_unknown"));
    expect(txLink(REMOVE_TRUSTLINE.hash)).toHaveLength(1);
    expect(trustlineNode()?.status).toBe("destroyed");

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Resume the close/ }));

    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(txLink(REMOVE_TRUSTLINE.hash)).toHaveLength(1);
    expect(txLink(MERGE.hash)).toHaveLength(1);
    // The reserve is the one read before the first round, two base reserves and the trustline's;
    // the resume, after a transaction landed, does not read it again.
    expect(usePlaygroundStore.getState().preCloseReserveXlm).toBe(1.5);
    expect(routes.count("POST /api/session")).toBe(1);
  });

  test("Start over on a funded, partly closed account warns before abandoning it", async () => {
    routes.handlers.set(ROUND, async () => ({ status: 502, body: { error: "demolish_failed" } }));
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    await rtl.screen.findByRole("button", { name: /Resume the close/ }, { timeout: 5000 });

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /^Start over$/ }));
    expect(rtl.screen.getByText(/Starting over abandons it there/)).toBeTruthy();
    expect(routes.count("POST /api/session")).toBe(1);

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "Keep it" }));
    expect(rtl.screen.queryByText(/Starting over abandons it there/)).toBeNull();
    expect(routes.count("POST /api/session")).toBe(1);

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /^Start over$/ }));
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "Abandon it and start over" }));
    await rtl.waitFor(() => expect(routes.count("POST /api/session")).toBe(2));
  });

  test("a decision the demo cannot make shows a blocker card naming it, not a generic failure", async () => {
    const id = "defi_positions:GDEMO";
    routes.handlers.set(ROUND, async () => ({
      status: 422,
      body: { error: "demolish_decision_unanswerable", decisions: [id] },
    }));
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));

    const card = await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(card.textContent).toContain("Blocked: a decision this demo cannot make");
    expect(card.textContent).toContain(errorCopy("demolish_decision_unanswerable"));
    const list = rtl.within(card).getByRole("list", { name: "Unanswered decisions" });
    expect(
      rtl
        .within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent)
    ).toEqual([id]);
    expect(rtl.screen.queryByText(errorCopy("demolish_failed"))).toBeNull();
    expect(rtl.screen.getByRole("button", { name: /Resume the close/ })).toBeTruthy();
  });

  test("any other error after a blocker shows the plain alert again", async () => {
    let rounds = 0;
    routes.handlers.set(ROUND, async () => {
      rounds++;
      return rounds === 1
        ? { status: 422, body: { error: "demolish_decision_unanswerable", decisions: ["x"] } }
        : { status: 502, body: { error: "demolish_failed" } };
    });
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    await rtl.screen.findByRole("list", { name: "Unanswered decisions" }, { timeout: 5000 });

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Resume the close/ }));
    await rtl.screen.findByText(errorCopy("demolish_failed"), undefined, { timeout: 5000 });
    expect(rtl.screen.queryByRole("list", { name: "Unanswered decisions" })).toBeNull();
  });

  test("a blocker the session can clear offers Resolve it, which fixes it and resumes the close", async () => {
    let rounds = 0;
    routes.handlers.set(ROUND, async () => {
      rounds++;
      return rounds === 1
        ? {
            status: 422,
            body: {
              error: "demolish_blocked",
              blockers: ["sponsorship_claimable_balance_unrevocable", "subentries_unenumerated"],
              resolvable: ["sponsorship_claimable_balance_unrevocable"],
            },
          }
        : { status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: 0 } };
    });
    const RESOLVE = `/api/session/${SESSION_ID}/resolve`;
    routes.handlers.set(RESOLVE, async () => ({
      status: 200,
      body: {
        ok: true,
        blocker: "sponsorship_claimable_balance_unrevocable",
        txHash: "e".repeat(64),
      },
    }));
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));

    const list = await rtl.screen.findByRole("list", { name: "Blockers" }, { timeout: 5000 });
    const items = rtl.within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      `${blockerCopy("sponsorship_claimable_balance_unrevocable")}Resolve it`,
      blockerCopy("subentries_unenumerated"),
    ]);
    // Only the blocker the session planned a fix for gets the button.
    expect(rtl.within(items[0]!).getByRole("button", { name: "Resolve it" })).toBeTruthy();
    expect(rtl.within(items[1]!).queryByRole("button", { name: "Resolve it" })).toBeNull();

    rtl.fireEvent.click(rtl.within(items[0]!).getByRole("button", { name: "Resolve it" }));
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(routes.count(`POST ${RESOLVE}`)).toBe(1);
    expect(routes.bodies).toContain(
      JSON.stringify({ blocker: "sponsorship_claimable_balance_unrevocable" })
    );
    expect(routes.count(`POST ${ROUND}`)).toBe(2);
  });

  test("a failed fix shows its own error and keeps the close resumable", async () => {
    routes.handlers.set(ROUND, async () => ({
      status: 422,
      body: {
        error: "demolish_blocked",
        blockers: ["sponsorship_unaffordable"],
        resolvable: ["sponsorship_unaffordable"],
      },
    }));
    routes.handlers.set(`/api/session/${SESSION_ID}/resolve`, async () => ({
      status: 502,
      body: { error: "resolve_failed" },
    }));
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));
    rtl.fireEvent.click(
      await rtl.screen.findByRole("button", { name: "Resolve it" }, { timeout: 5000 })
    );
    await rtl.screen.findByText(errorCopy("resolve_failed"), undefined, { timeout: 5000 });
    expect(rtl.screen.getByRole("button", { name: /Resume the close/ })).toBeTruthy();
  });

  test("an error before the close started keeps the single Start over, with no warning", async () => {
    routes.handlers.set("/api/session", async () => ({
      status: 502,
      body: { error: "provision_failed" },
    }));
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });

    expect(rtl.screen.queryByRole("button", { name: /Resume the close/ })).toBeNull();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /^Start over$/ }));
    expect(rtl.screen.queryByText(/Starting over abandons it there/)).toBeNull();
    await rtl.waitFor(() => expect(routes.count("POST /api/session")).toBe(2));
  });
});

describe("the scenario picker", () => {
  beforeEach(() => {
    usePlaygroundStore
      .getState()
      .setSelection(resolvePlan(STANDARD_SELECTION).selection, "classic");
    usePlaygroundStore.getState().setUnavailable(new Map());
  });

  const button = (name: string | RegExp) => rtl.screen.getByRole("button", { name });
  const totals = () => {
    const values = [...document.querySelectorAll("dd")].map((d) => d.textContent);
    const steps = [...document.querySelectorAll("ol li")].map((li) => li.textContent);
    return { values, steps };
  };

  describe("presets and toggles", () => {
    test("the classic preset is pressed and its totals and steps are shown before the run", () => {
      rtl.render(<ScenarioPicker />);
      expect(button(/Classic account teardown/).getAttribute("aria-pressed")).toBe("true");
      const plan = resolvePlan(STANDARD_SELECTION);
      expect(totals()).toEqual({
        values: [String(plan.cost.xlm), String(plan.steps.length), "~2 min"],
        steps: plan.steps.map((s) => s.label),
      });
    });

    test("toggling a scenario off updates the totals and the steps, and leaves the preset", () => {
      rtl.render(<ScenarioPicker />);
      const signer = button(/^Forgotten co-signer/);
      expect(signer.getAttribute("aria-pressed")).toBe("true");
      rtl.fireEvent.click(signer);

      expect(button(/^Forgotten co-signer/).getAttribute("aria-pressed")).toBe("false");
      expect(button(/Classic account teardown/).getAttribute("aria-pressed")).toBe("false");
      expect(totals().steps).not.toContain("Add a forgotten co-signer");
      expect(totals().values[1]).toBe(String(resolvePlan(STANDARD_SELECTION).steps.length - 1));

      rtl.fireEvent.click(button(/Classic account teardown/));
      expect(totals().steps).toContain("Add a forgotten co-signer");
    });

    test("a parameter counter changes the plan", () => {
      rtl.render(<ScenarioPicker />);
      rtl.fireEvent.click(button("Fewer entries"));
      expect(totals().steps).toContain("Attach 2 leftover data entries");
    });

    test("a disposition is picked by name, and the plan follows it", () => {
      usePlaygroundStore
        .getState()
        .setSelection(
          { scenarios: [{ id: "dispositions", params: { lwcoin: 0, lwgem: 0 } }] },
          null
        );
      rtl.render(<ScenarioPicker />);
      const gem = rtl.screen.getByRole("combobox", { name: "LWGEM" });
      expect([...gem.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
        "Burn (return to issuer)",
        "Convert to XLM",
        "Transfer to another account",
      ]);
      expect(totals().steps).not.toContain("Open an account that can receive LWGEM");
      rtl.fireEvent.change(gem, { target: { value: "2" } });
      expect(totals().steps).toContain("Open an account that can receive LWGEM");
      expect(usePlaygroundStore.getState().selection.scenarios[0]?.params).toEqual({
        lwcoin: 0,
        lwgem: 2,
      });
    });

    test("turning on a scenario that needs a token pulls one in", () => {
      usePlaygroundStore
        .getState()
        .setSelection({ scenarios: [{ id: "data-entries", params: { count: 1 } }] }, null);
      rtl.render(<ScenarioPicker />);
      rtl.fireEvent.click(button(/^Stale DEX offers/));
      expect(button(/^Demo token holding/).getAttribute("aria-pressed")).toBe("true");
    });

    test("a scenario switched off here is disabled with its reason", () => {
      usePlaygroundStore
        .getState()
        .setUnavailable(new Map([["stale-offers", "Switched off on this deployment for now."]]));
      rtl.render(<ScenarioPicker />);
      const offers = button(/^Stale DEX offers/);
      expect(offers.hasAttribute("disabled")).toBe(true);
      const reason = document.getElementById(offers.getAttribute("aria-describedby") ?? "");
      expect(reason?.textContent).toBe("Switched off on this deployment for now.");
    });

    test("a feature set with nothing to run says so and cannot be chosen", () => {
      usePlaygroundStore.getState().setUnavailable(
        new Map([
          ["fee-bump", "Not set up on this deployment."],
          ["exchange-close", "Not set up on this deployment."],
        ])
      );
      rtl.render(<ScenarioPicker />);
      const api = button(/API, batch and exchange/);
      expect(api.getAttribute("aria-disabled")).toBe("true");
      expect(api.textContent).toContain("No scenarios in this set run on this deployment yet.");
      rtl.fireEvent.click(api);
      expect(button(/Classic account teardown/).getAttribute("aria-pressed")).toBe("true");
    });

    test("a protocol scenario testnet cannot run is listed with its reason, never as a toggle", () => {
      rtl.render(<ScenarioPicker />);
      const reason = rtl.screen.getByText(/^Not on testnet: converting a Soroban token/);
      expect(reason.closest("button")).toBeNull();
      expect(rtl.screen.getByText("Soroban token conversion").closest("button")).toBeNull();
      expect(rtl.screen.queryByRole("button", { name: /Soroban token conversion/ })).toBeNull();
    });

    test("a random wallet shows its replay code before anything runs", () => {
      rtl.render(<ScenarioPicker />);
      rtl.fireEvent.click(button(/Random wallet/));
      const { seed, selection, preset } = usePlaygroundStore.getState();
      expect(preset).toBe("random");
      expect(seed).toMatch(/^LW1-[0-9A-Z]{8}$/);
      expect(rtl.screen.getByText(seed!)).toBeTruthy();
      expect(button("Copy the replay code")).toBeTruthy();
      const parsed = parseReplayCode(seed!)!;
      expect(selection).toEqual(generateRandomSelection(parsed.seed)!);
      expect(totals().steps).toEqual(resolvePlan(selection).steps.map((s) => s.label));
    });

    test("a replay code typed in replays that exact wallet; anything else says so", () => {
      rtl.render(<ScenarioPicker />);
      const input = rtl.screen.getByLabelText("Replay a seed");
      rtl.fireEvent.change(input, { target: { value: "lw1-0g847jzv" } });
      rtl.fireEvent.click(button("Replay"));
      const state = usePlaygroundStore.getState();
      expect(state.seed).toBe("LW1-0G847JZV");
      expect(state.selection).toEqual(generateRandomSelection(17_452_747_771)!);

      rtl.fireEvent.change(input, { target: { value: "LW1-NOPE" } });
      rtl.fireEvent.click(button("Replay"));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(
        rtl.screen.getByText(/That is not a replay code this playground can run/)
      ).toBeTruthy();
      expect(usePlaygroundStore.getState().seed).toBe("LW1-0G847JZV");
    });

    test("editing a random wallet by hand drops its replay code", () => {
      rtl.render(<ScenarioPicker />);
      rtl.fireEvent.click(button(/Random wallet/));
      const first = usePlaygroundStore.getState().selection.scenarios[0]!;
      const def = SCENARIOS.find((s) => s.id === first.id)!;
      rtl.fireEvent.click(button(new RegExp(`^${def.label}`)));
      expect(usePlaygroundStore.getState().seed).toBeNull();
    });

    test("an empty selection shows why it cannot run", () => {
      usePlaygroundStore.getState().setSelection({ scenarios: [] }, null);
      rtl.render(<ScenarioPicker />);
      expect(rtl.screen.getByText("Pick at least one scenario.")).toBeTruthy();
    });
  });

  describe("keyboard and names", () => {
    test("arrow keys, Home and End move along the preset row", () => {
      rtl.render(<ScenarioPicker />);
      const row = rtl.screen.getByRole("group", { name: "Presets" });
      const presets = [...row.querySelectorAll("button")];
      presets[0]!.focus();
      rtl.fireEvent.keyDown(row, { key: "ArrowRight" });
      expect(document.activeElement).toBe(presets[1]!);
      rtl.fireEvent.keyDown(row, { key: "End" });
      expect(document.activeElement).toBe(presets[presets.length - 1]!);
      rtl.fireEvent.keyDown(row, { key: "ArrowRight" });
      expect(document.activeElement).toBe(presets[0]!);
      rtl.fireEvent.keyDown(row, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(presets[presets.length - 1]!);
      rtl.fireEvent.keyDown(row, { key: "Home" });
      expect(document.activeElement).toBe(presets[0]!);
    });

    test("every toggle has an accessible name and a pressed state", () => {
      rtl.render(<ScenarioPicker />);
      const toggles = [...document.querySelectorAll("fieldset button[aria-pressed]")];
      expect(toggles.length).toBe(SCENARIOS.length);
      for (const toggle of toggles) expect(toggle.textContent?.length).toBeGreaterThan(0);
    });
  });

  describe("the scene", () => {
    const dock = (...specs: { id: string; kind: string; label: string }[]): void => {
      const store = usePlaygroundStore.getState();
      store.reset();
      store.dockNodes(
        specs.map((spec, i) => buildSceneNode(spec, i)),
        "d".repeat(64)
      );
    };
    const orbitButtons = (): HTMLButtonElement[] => [
      ...document.querySelectorAll<HTMLButtonElement>(
        'ul[aria-label="Entries on the demo account"] button'
      ),
    ];
    const MIXED = [
      { id: "cb:claim:0", kind: "claimable", label: "BONUS" },
      { id: "tl:LWDEMO", kind: "trustline", label: "LWDEMO" },
      { id: "signer:cosigner:1", kind: "multisig", label: "Co-signer 1" },
      { id: "sponsorship:data", kind: "sponsorship", label: "sponsored_by_demo" },
      { id: "data:promo", kind: "data", label: "promo" },
    ];

    test("a node of a kind this client does not know renders as a generic node", () => {
      const node = buildSceneNode({ id: "vault:1", kind: "vault", label: "Vault" }, 0);
      expect(node.kind).toBe("generic");
      dock({ id: "vault:1", kind: "vault", label: "Vault" });
      rtl.render(<OrbitalScene />);
      expect(rtl.screen.getByText("Vault")).toBeTruthy();
      expect(rtl.screen.getByRole("button", { name: "Entry Vault, on testnet" })).toBeTruthy();
    });

    test("an allowance node keeps its kind and draws its label and amount", () => {
      const node = buildSceneNode({ id: "allowance:1", kind: "allowance", label: "Spender 1" }, 0);
      expect(node.kind).toBe("allowance");
      dock({ id: "allowance:1", kind: "allowance", label: "Spender 1" });
      usePlaygroundStore.getState().updateNode("allowance:1", { balance: "10" });
      rtl.render(<OrbitalScene />);
      expect(rtl.screen.getByText("Spender 1")).toBeTruthy();
      expect(rtl.screen.getByText("10")).toBeTruthy();
    });

    test("each orbit node's name matches its list row", () => {
      dock(...MIXED);
      usePlaygroundStore.getState().updateNode("tl:LWDEMO", { balance: "25" });
      rtl.render(<OrbitalScene />);
      const named = orbitButtons().map((b) => b.getAttribute("aria-label") ?? "");
      expect(named).toHaveLength(MIXED.length);
      rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "List" }));
      const rows = [...document.querySelectorAll("[data-scene-name]")].map(
        (r) => r.textContent ?? ""
      );
      expect(rows).toEqual(named);
      expect(rows).toContain("Trustline LWDEMO, balance 25, on testnet");
      expect(rows).toContain("Claimable balance BONUS, on testnet");
    });

    test("a removed node stays in the list with the transaction that removed it", () => {
      dock(...MIXED);
      usePlaygroundStore.getState().destroyNodes(["data:promo"], "e".repeat(64));
      rtl.render(<OrbitalScene />);
      expect(orbitButtons().map((b) => b.getAttribute("aria-label"))).not.toContain(
        "Data entry promo, removed"
      );
      rtl.fireEvent.click(rtl.screen.getByRole("button", { name: "List" }));
      expect(rtl.screen.getByText("Data entry promo, removed")).toBeTruthy();
      expect(txLink("e".repeat(64))).toHaveLength(1);
    });

    test("the orbit is one tab stop and the arrow keys move between nodes", () => {
      dock(...MIXED);
      rtl.render(<OrbitalScene />);
      const buttons = orbitButtons();
      const stops = (): HTMLButtonElement[] => orbitButtons().filter((b) => b.tabIndex === 0);
      expect(stops()).toEqual([buttons[0]!]);
      // Ring order: the multisig signer, the trustline, the data entry, then the outer ring.
      expect(buttons.map((b) => b.getAttribute("aria-label")?.split(",")[0])).toEqual([
        "Multi-signature signer Co-signer 1",
        "Trustline LWDEMO",
        "Data entry promo",
        "Claimable balance BONUS",
        "Sponsored reserve sponsored_by_demo",
      ]);
      rtl.act(() => buttons[0]!.focus());
      rtl.fireEvent.keyDown(buttons[0]!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(buttons[1]!);
      expect(stops()).toEqual([buttons[1]!]);
      rtl.fireEvent.keyDown(buttons[1]!, { key: "End" });
      expect(document.activeElement).toBe(buttons[4]!);
      rtl.fireEvent.keyDown(buttons[4]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(buttons[0]!);
      rtl.fireEvent.keyDown(buttons[0]!, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(buttons[4]!);
      rtl.fireEvent.keyDown(buttons[4]!, { key: "Home" });
      expect(document.activeElement).toBe(buttons[0]!);
    });

    test("removing the focused node moves focus to the one that takes its place", async () => {
      dock(...MIXED);
      rtl.render(<OrbitalScene />);
      const buttons = orbitButtons();
      rtl.act(() => buttons[1]!.focus());
      rtl.act(() => usePlaygroundStore.getState().destroyNodes(["tl:LWDEMO"], "f".repeat(64)));
      await rtl.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Data entry promo, on testnet"
        )
      );
      expect(orbitButtons().filter((b) => b.tabIndex === 0)).toHaveLength(1);
    });

    test("pressing a node shows its label, Escape hides it again", () => {
      dock(...MIXED);
      rtl.render(<OrbitalScene />);
      const button = orbitButtons()[0]!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      rtl.fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      rtl.fireEvent.keyDown(button, { key: "Escape" });
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    test("the legend lists each kind in the scene once, in ring order", () => {
      dock(...MIXED, { id: "tl:GIFT", kind: "trustline", label: "GIFT" });
      rtl.render(<OrbitalScene />);
      const legend = rtl.screen.getByRole("list", { name: "Legend" });
      expect([...legend.querySelectorAll("li")].map((li) => li.textContent?.split(":")[0])).toEqual(
        [
          "Multi-signature signer",
          "Trustline",
          "Data entry",
          "Claimable balance",
          "Sponsored reserve",
        ]
      );
    });

    test("an empty scene has no toolbar, legend or list", () => {
      usePlaygroundStore.getState().reset();
      rtl.render(<OrbitalScene />);
      expect(rtl.screen.queryByRole("group", { name: "Scene view" })).toBeNull();
      expect(rtl.screen.queryByRole("list", { name: "Legend" })).toBeNull();
      expect(rtl.screen.queryByRole("list", { name: "Entries on the demo account" })).toBeNull();
    });

    test("an offer node is bound to the chain offer that trades its pair", () => {
      const spec = {
        id: "offer:1",
        kind: "offer",
        label: "Sell AIRDROP1 → XLM",
        offer: { selling: "AIRDROP1" as const, buying: "native" as const },
      };
      const store = usePlaygroundStore.getState();
      store.reset();
      store.dockNodes([buildSceneNode(spec, 0)], "h");
      store.bindOffers([
        { id: "7", selling: "native", buying: "LWDEMO:GISSUER" },
        { id: "8", selling: "AIRDROP1:GISSUER", buying: "native" },
      ]);
      expect(usePlaygroundStore.getState().nodes[0]?.offerId).toBe("8");
    });
  });
});

describe("the replay code reaches the run, the summary and every error", () => {
  const CODE = "LW1-0G847JZV";

  test("a random wallet is sent as its code, which the server regenerates", async () => {
    usePlaygroundStore
      .getState()
      .setSelection(generateRandomSelection(17_452_747_771)!, "random", CODE);
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    await rtl.screen.findByRole("button", { name: /Demolish it here/ }, { timeout: 5000 });
    expect(JSON.parse(routes.bodies[0]!)).toEqual({ seed: CODE });
  });

  test("an error shows the code, so the wallet can be reported and replayed", async () => {
    usePlaygroundStore
      .getState()
      .setSelection(generateRandomSelection(17_452_747_771)!, "random", CODE);
    routes.handlers.set("/api/session", async () => ({
      status: 502,
      body: { error: "provision_failed" },
    }));
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    const alert = await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert.textContent).toBe(`${errorCopy("provision_failed")}Replay code ${CODE}`);
  });

  test("the summary shows the code", async () => {
    usePlaygroundStore
      .getState()
      .setSelection(generateRandomSelection(17_452_747_771)!, "random", CODE);
    usePlaygroundStore.getState().setPhase("COMPLETE");
    rtl.render(<Harness />);
    expect((await rtl.screen.findByText(/demo complete/)).textContent).toContain(
      `Replay code ${CODE}`
    );
  });

  test("a hand-picked selection is sent as itself, with no code anywhere", async () => {
    usePlaygroundStore
      .getState()
      .setSelection(resolvePlan(STANDARD_SELECTION).selection, "classic");
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    await rtl.screen.findByRole("button", { name: /Demolish it here/ }, { timeout: 5000 });
    expect(JSON.parse(routes.bodies[0]!)).toEqual({
      selection: resolvePlan(STANDARD_SELECTION).selection,
    });
    expect(rtl.screen.queryByText(/Replay code/)).toBeNull();
  });
});

describe("a shared link is applied before the run can start", () => {
  const createButton = () =>
    rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }) as HTMLButtonElement;

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  test("a shared selection: Create waits for it, then runs exactly that selection", async () => {
    const shared = encodeSelection({
      scenarios: [{ id: "dispositions", params: { lwcoin: 1, lwgem: 2 } }],
    });
    window.history.replaceState(null, "", `/?selection=${shared}`);
    const scenarios = deferred<{ status: number; body: unknown }>();
    routes.handlers.set("/api/scenarios", () => scenarios.promise);

    rtl.render(<PlaygroundClient />);
    // A visitor clicking before the link is applied must not start the default wallet.
    expect(createButton().disabled).toBe(true);

    await rtl.act(async () => scenarios.resolve({ status: 200, body: { unavailable: [] } }));
    await rtl.waitFor(() => expect(createButton().disabled).toBe(false));
    expect(
      rtl.screen.getByRole("button", { name: /Convert, transfer or burn/, pressed: true })
    ).toBeDefined();
    rtl.fireEvent.click(createButton());
    await rtl.waitFor(() => expect(routes.bodies.length).toBe(1));
    expect(JSON.parse(routes.bodies[0]!)).toEqual({ selection: decodeSelection(shared) });
  });

  test("a shared seed: Create waits even when the availability check fails", async () => {
    const CODE = "LW1-0G847JZV";
    window.history.replaceState(null, "", `/?seed=${CODE}`);
    const scenarios = deferred<{ status: number; body: unknown }>();
    routes.handlers.set("/api/scenarios", () => scenarios.promise);

    rtl.render(<PlaygroundClient />);
    expect(createButton().disabled).toBe(true);

    await rtl.act(async () =>
      scenarios.resolve({ status: 503, body: { error: "not_configured" } })
    );
    await rtl.waitFor(() => expect(createButton().disabled).toBe(false));
    rtl.fireEvent.click(createButton());
    await rtl.waitFor(() => expect(routes.bodies.length).toBe(1));
    expect(JSON.parse(routes.bodies[0]!)).toEqual({ seed: CODE });
  });
});

describe("the run explains itself", () => {
  const CREDENTIALS = `/api/session/${SESSION_ID}/credentials`;
  const STATE = `/api/session/${SESSION_ID}/state`;
  const MESS = `/api/session/${SESSION_ID}/mess`;
  // Not key-shaped on purpose: no strkey and no hex run.
  const SECRET = "demo-secret-placeholder";

  function createAnswering(expiresAt: number): void {
    const plan = getMessPlanForMode("light");
    routes.handlers.set("/api/session", async () => ({
      status: 200,
      body: {
        sessionId: SESSION_ID,
        demoPublic: "GDEMO",
        expiresAt,
        messPlan: plan,
        accounts: { issuer: ISSUER, mm: "GSINK", lwdemoAsset: `LWDEMO:${ISSUER}`, ephemeral: [] },
      },
    }));
  }

  test("the status region is in the page, empty, before a run starts", () => {
    rtl.render(<Harness />);
    const region = document.querySelector('[role="status"][aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
  });

  test("before the run, the panel lists what it will create and how long the account lives", () => {
    rtl.render(<Harness />);
    const list = rtl.screen.getByRole("region", { name: "This will create on testnet" });
    const lines = [...list.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines).toEqual(willCreate(resolvePlan(STANDARD_SELECTION).steps));
    expect(list.textContent).toContain("lives for one hour, with one 30-minute extension");
  });

  test("the account state is read after every setup step, and shown", async () => {
    await dirtyAccount();
    const steps = getMessPlanForMode("light").length;
    // One read per step, then the one the close starts from.
    expect(routes.count(`GET ${STATE}`)).toBe(steps + 1);
    const panel = rtl.screen.getByRole("region", { name: "Demo account right now" });
    expect(panel.textContent).toContain("1.5 XLM");
    expect(panel.textContent).toContain("low 0, medium 0, high 0");
  });

  test("a failed state read between steps leaves the run going", async () => {
    let reads = 0;
    routes.handlers.set(STATE, async () => {
      reads++;
      return reads === 1
        ? { status: 502, body: { error: "state_read_failed" } }
        : { status: 200, body: routes.state };
    });
    await dirtyAccount();
    expect(usePlaygroundStore.getState().phase).toBe("DIRTY");
  });

  test("each credential failure has its own plain copy", async () => {
    const answers: [number, string][] = [
      [429, "rate_limited"],
      [410, "session_expired"],
      [404, "session_not_found"],
      [503, "not_configured"],
    ];
    const shown: string[] = [];
    for (const [status, code] of answers) {
      rtl.cleanup();
      routes = new FakeRoutes();
      globalThis.fetch = Object.assign(routes.fetch, { preconnect: originalFetch.preconnect });
      usePlaygroundStore.getState().reset();
      routes.handlers.set(CREDENTIALS, async () => ({ status, body: { error: code } }));
      await dirtyAccount();
      rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Try the demolish flow/ }));
      const alert = await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });
      expect(alert.textContent).toBe(credentialsErrorCopy(code));
      expect(alert.textContent).not.toContain(code);
      shown.push(alert.textContent ?? "");
    }
    // Expired, gone and limited each read differently; only "unavailable" is shared.
    expect(new Set(shown).size).toBe(4);
  });

  test("a revealed secret is masked again after thirty seconds", async () => {
    routes.handlers.set(CREDENTIALS, async () => ({
      status: 200,
      body: { publicKey: "GDEMO", secretKey: SECRET },
    }));
    await dirtyAccount();
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Try the demolish flow/ }));
    const reveal = await rtl.screen.findByRole("button", { name: "Reveal the secret key" });
    expect(rtl.screen.getByText(/about to be merged away/)).toBeTruthy();
    expect(rtl.screen.queryByText(SECRET)).toBeNull();

    jest.useFakeTimers();
    try {
      rtl.fireEvent.click(reveal);
      expect(rtl.screen.getByText(SECRET)).toBeTruthy();
      for (let s = 0; s < 29; s++) rtl.act(() => jest.advanceTimersByTime(1000));
      expect(rtl.screen.getByText(SECRET)).toBeTruthy();
      rtl.act(() => jest.advanceTimersByTime(1000));
      expect(rtl.screen.queryByText(SECRET)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("five minutes before the end, it warns and offers one extension", async () => {
    const extended = Date.now() + 34 * 60_000;
    createAnswering(Date.now() + 4 * 60_000);
    routes.handlers.set(`/api/session/${SESSION_ID}/extend`, async () => ({
      status: 200,
      body: { expiresAt: extended, extended: true },
    }));
    await dirtyAccount();
    expect(rtl.screen.getByText(WARNING_COPY, { ignore: ".sr-only" })).toBeTruthy();
    await rtl.waitFor(() => expect(liveStatus()).toBe(WARNING_COPY));

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Add 30 minutes/ }));
    await rtl.waitFor(() => expect(usePlaygroundStore.getState().extended).toBe(true));
    expect(usePlaygroundStore.getState().expiresAt).toBe(extended);
    expect(rtl.screen.queryByRole("button", { name: /Add 30 minutes/ })).toBeNull();
    expect(routes.count(`POST /api/session/${SESSION_ID}/extend`)).toBe(1);
  });

  test("once time is up the key is withheld, and the close is still offered", async () => {
    createAnswering(Date.now() - 1000);
    await dirtyAccount();
    expect(rtl.screen.getByText(TIME_UP_COPY, { ignore: ".sr-only" })).toBeTruthy();
    const keys = rtl.screen.getByRole("button", { name: /Try the demolish flow/ });
    expect((keys as HTMLButtonElement).disabled).toBe(true);
    const close = rtl.screen.getByRole("button", { name: /Demolish it here/ });
    expect((close as HTMLButtonElement).disabled).toBe(false);
  });

  test("a setup step refused for time offers to close what was created", async () => {
    routes.handlers.set(MESS, async () => ({ status: 410, body: { error: "session_expired" } }));
    routes.handlers.set(ROUND, async () => ({
      status: 200,
      body: { done: true, confirmed: [MERGE], remainingSteps: 0 },
    }));
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    const close = await rtl.screen.findByRole(
      "button",
      { name: /Close the demo account now/ },
      { timeout: 5000 }
    );
    expect(usePlaygroundStore.getState().expiredReason).toBe("time_up");
    rtl.fireEvent.click(close);
    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(routes.count(`POST ${ROUND}`)).toBe(1);
  });

  test("a session whose record is gone offers only a new one", async () => {
    routes.handlers.set(MESS, async () => ({ status: 404, body: { error: "session_not_found" } }));
    rtl.render(<Harness />);
    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Create & trash a demo account/ }));
    await rtl.screen.findByRole("button", { name: /Start a new session/ }, { timeout: 5000 });
    expect(rtl.screen.queryByRole("button", { name: /Close the demo account now/ })).toBeNull();
    expect(usePlaygroundStore.getState().expiredReason).toBe("gone");
  });
});

describe("the receipt", () => {
  const ACCOUNT = "GDEMO";
  const REMOVE = "d".repeat(64);
  const MERGED = "e".repeat(64);
  const SINK = "GSINKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZZZZ";
  const receiptPath = (hash: string, account = ACCOUNT) =>
    `/api/receipt?${new URLSearchParams({ account, hash }).toString()}`;
  const readRemove = {
    hash: REMOVE,
    status: "read",
    feeStroops: "100",
    feePaidBy: "sponsor",
    operations: [{ type: "changeTrust", count: 1 }],
    merge: null,
  };
  const readMerge = {
    hash: MERGED,
    status: "read",
    feeStroops: "200",
    feePaidBy: "sponsor",
    operations: [{ type: "accountMerge", count: 1 }],
    merge: { into: "destination", amountStroops: "99995000000", destination: SINK },
  };
  let copied: string[];

  beforeEach(() => {
    copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    });
  });

  const answer = (hash: string, body: unknown, account = ACCOUNT): void => {
    routes.handlers.set(receiptPath(hash, account), async () => ({ status: 200, body }));
  };

  function complete(reserve: number | null): void {
    usePlaygroundStore.setState({
      phase: "COMPLETE",
      sessionId: SESSION_ID,
      demoPublic: ACCOUNT,
      preCloseReserveXlm: reserve,
      sdkSnippet: 'const source = "GDEMO";',
      log: [
        { id: "1", label: "Remove the trustline", txHash: REMOVE, kind: "demolish", at: 1 },
        { id: "2", label: "Close the account", txHash: MERGED, kind: "demolish", at: 2 },
      ],
    });
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };

  test("reads the fee and the merge from each confirmed transaction, with one SDK panel", async () => {
    answer(REMOVE, readRemove);
    answer(MERGED, readMerge);
    complete(1.5);
    rtl.render(<PlaygroundClient />);

    await rtl.screen.findByText("9999.5 XLM");
    expect(rtl.screen.getByText(/to GSIN…ZZZZ/)).toBeTruthy();
    expect(rtl.screen.getByText(/of which 1.5 XLM was the reserve/)).toBeTruthy();
    expect(rtl.screen.getByText("0.00003 XLM paid by LumenWipe's fee sponsor")).toBeTruthy();
    const operations = rtl.screen.getByRole("list", { name: "Operations by type" });
    expect(operations.textContent).toContain("Trustline change: 1");
    expect(operations.textContent).toContain("Account merge: 1");
    const receipt = rtl.screen.getByRole("region", { name: "Receipt" });
    const links = rtl
      .within(receipt)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(links).toEqual([EXPLORER_TX + REMOVE, EXPLORER_TX + MERGED]);
    expect(rtl.screen.getAllByText("This close with the SDK")).toHaveLength(1);
    expect(routes.count(`GET ${receiptPath(MERGED)}`)).toBe(1);
  });

  test("shows no reserve line when the read before the close is missing", async () => {
    answer(REMOVE, readRemove);
    answer(MERGED, readMerge);
    complete(null);
    rtl.render(<PlaygroundClient />);

    await rtl.screen.findByText("9999.5 XLM");
    expect(rtl.screen.queryByText(/was the reserve/)).toBeNull();
  });

  test("an exchange close names the forward and its memo, not the relay", async () => {
    answer(REMOVE, readRemove);
    answer(MERGED, {
      ...readMerge,
      merge: {
        into: "relay",
        amountStroops: "99995000000",
        forwarded: { amountStroops: "99994900000", to: SINK, memo: "4242" },
      },
    });
    complete(1.5);
    rtl.render(<PlaygroundClient />);

    await rtl.screen.findByText("9999.5 XLM");
    expect(rtl.screen.getByText(/forwarded 9999.49 XLM with memo 4242/)).toBeTruthy();
  });

  test("no total is shown until every transaction reads, and a retry reads the rest", async () => {
    answer(REMOVE, readRemove);
    answer(MERGED, { hash: MERGED, status: "pending" });
    complete(1.5);
    jest.useFakeTimers();
    try {
      rtl.render(<PlaygroundClient />);
      await rtl.act(flush);
      expect(rtl.screen.getByText(/Reading each transaction from the ledger/)).toBeTruthy();
      expect(rtl.screen.queryByText(/XLM paid by/)).toBeNull();
      for (let attempt = 1; attempt < 6; attempt++) {
        await rtl.act(async () => {
          jest.advanceTimersByTime(2_000);
          await flush();
        });
      }
      expect(routes.count(`GET ${receiptPath(MERGED)}`)).toBe(6);
      expect(rtl.screen.getByText(/so no total is shown/)).toBeTruthy();
      expect(rtl.screen.queryByText(/XLM paid by/)).toBeNull();

      answer(MERGED, readMerge);
      rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Read again/ }));
      await rtl.act(flush);
      expect(rtl.screen.getByText("0.00003 XLM paid by LumenWipe's fee sponsor")).toBeTruthy();
      expect(routes.count(`GET ${receiptPath(REMOVE)}`)).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("shares the exact selection and nothing that grants access", async () => {
    answer(REMOVE, readRemove);
    answer(MERGED, readMerge);
    complete(1.5);
    rtl.render(<PlaygroundClient />);
    await rtl.screen.findByText("9999.5 XLM");

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Share this case/ }));
    await rtl.waitFor(() => expect(copied).toHaveLength(1));
    const link = new URL(copied[0]!);
    expect([...link.searchParams.keys()]).toEqual(["selection"]);
    expect(decodeSelection(link.searchParams.get("selection") ?? "")).toEqual(
      usePlaygroundStore.getState().selection
    );
    expect(copied[0]).not.toContain(SESSION_ID);
    expect(copied[0]).not.toContain(ACCOUNT);
  });

  test("a batch lists each account, the blocked one with nothing sent, and shares its size", async () => {
    const closedHash = "f".repeat(64);
    answer(closedHash, { ...readMerge, hash: closedHash, feePaidBy: "account" }, "GCLOSED");
    const member = (sessionId: string, demoPublic: string, close: "closed" | "blocked") => ({
      sessionId,
      demoPublic,
      label: close === "closed" ? "Demo token holding" : "Claimable balances",
      messPlan: [],
      messDone: 0,
      plan: null,
      close,
      stop: null,
      message: null,
      hashes: close === "closed" ? [closedHash] : [],
    });
    usePlaygroundStore.getState().setBatchSize(2);
    usePlaygroundStore.setState({
      phase: "COMPLETE",
      batch: {
        batchId: "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
        blockedIndex: 1,
        members: [
          member("1a2b3c4d-1111-4222-8333-444455556666", "GCLOSED", "closed"),
          member("1a2b3c4d-2222-4333-8444-555566667777", "GBLOCKED", "blocked"),
        ],
      },
    });
    rtl.render(<PlaygroundClient />);

    const rows = await rtl.screen.findByRole("list", { name: "Each account's close" });
    await rtl.waitFor(() =>
      expect(rows.textContent).toContain("9999.5 XLM merged, fees 0.00002 XLM")
    );
    expect(rows.textContent).toContain(
      "Reported blocked before anything was sent: no close transaction, nothing merged"
    );
    expect(rows.textContent).not.toContain("0 XLM merged");
    expect(rtl.screen.getByText("0.00002 XLM paid by the demo account")).toBeTruthy();
    expect(routes.calls.some((c) => c.includes("GBLOCKED"))).toBe(false);

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Share this case/ }));
    await rtl.waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toBe("http://localhost:3002/?batch=2");
  });
});

describe("the duration the picker shows", () => {
  test("keeps the estimate while no nightly measurement exists", () => {
    rtl.render(<ScenarioPicker />);
    expect(rtl.screen.getByText("Estimated")).toBeTruthy();
    expect(rtl.screen.queryByText("Measured")).toBeNull();
    expect(rtl.screen.queryByText(/nightly run/)).toBeNull();
  });

  test("shows the measured range with its date and run count once measured", () => {
    const unit = (low: number, high: number) => ({ samples: 10, low, high });
    rtl.render(
      <ScenarioPicker
        measured={{
          measuredAt: "2026-11-15",
          runs: ["43600000001", "43600000002"],
          units: {
            setup: unit(10, 20),
            classicStep: unit(3, 6),
            sorobanStep: unit(8, 12),
            closeRound: unit(10, 30),
          },
          coverage: { inside: 9, tests: 10 },
        }}
      />
    );
    expect(rtl.screen.getByText("Measured")).toBeTruthy();
    expect(rtl.screen.queryByText("Estimated")).toBeNull();
    expect(rtl.screen.getByText(/Timed across 2 nightly runs from 2026-11-15/)).toBeTruthy();
  });
});
