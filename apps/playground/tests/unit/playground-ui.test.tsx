import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { IntentOperation } from "@lumenwipe/sdk";
import { blockerCopy, errorCopy } from "@/lib/error-copy";
import { getMessPlanForMode } from "@/lib/mess-plan";
import {
  SCENARIOS,
  STANDARD_SELECTION,
  decodeSelection,
  encodeSelection,
  generateRandomSelection,
  parseReplayCode,
  resolvePlan,
} from "@/lib/scenarios";
import { usePlaygroundStore, type PlaygroundPhase } from "@/store/playground";
import { buildSceneNode, usePlaygroundExecution } from "@/hooks/usePlaygroundExecution";
import PlaygroundControls from "@/components/scene/PlaygroundControls";
import TxLogPanel from "@/components/scene/TxLogPanel";
import SdkSnippetPanel from "@/components/scene/SdkSnippetPanel";
import ScenarioPicker from "@/components/scene/ScenarioPicker";
import OrbitalNode from "@/components/scene/OrbitalNode";
import PlaygroundClient from "@/app/PlaygroundClient";
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
const rtl = await import("@testing-library/react");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const SESSION_ID = "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01";
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
    accountState: { nativeBalanceLumens: "9999.5", numSubEntries: 1, openOffers: [] },
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
  return (
    <>
      <PlaygroundControls
        start={start}
        demolish={demolish}
        resolve={resolve}
        progressStatus={progressStatus}
      />
      <TxLogPanel />
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
  // The picked scenarios survive reset by design; each test starts from the classic preset.
  usePlaygroundStore.getState().setSelection(resolvePlan(STANDARD_SELECTION).selection, "classic");
});

afterEach(() => {
  rtl.cleanup();
  globalThis.fetch = originalFetch;
});

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
    expect(demolishCalls.slice(0, 4)).toEqual([
      `GET ${ALLOWANCES}`,
      `POST ${REVOKE}`,
      `POST ${REVOKE}`,
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
    expect(rtl.screen.getByText("Closing the account, round 2 of about 2...")).toBeTruthy();
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
      if (rounds === 1) return { status: 502, body: { error: "demolish_outcome_unknown" } };
      return { status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: 0 } };
    });
    await dirtyAccount();
    // What the failed round confirmed before it stopped is in the session log.
    routes.state = {
      ...routes.state,
      accountState: { nativeBalanceLumens: "9999.0", numSubEntries: 0 },
      demolishLog: [REMOVE_TRUSTLINE],
    };

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Demolish it here/ }));

    const alert = await rtl.screen.findByRole("alert", undefined, { timeout: 5000 });
    expect(alert.textContent).toBe(errorCopy("demolish_outcome_unknown"));
    expect(txLink(REMOVE_TRUSTLINE.hash)).toHaveLength(1);
    expect(trustlineNode()?.status).toBe("destroyed");

    rtl.fireEvent.click(rtl.screen.getByRole("button", { name: /Resume the close/ }));

    await rtl.screen.findByText(/demo complete/, undefined, { timeout: 5000 });
    expect(txLink(REMOVE_TRUSTLINE.hash)).toHaveLength(1);
    expect(txLink(MERGE.hash)).toHaveLength(1);
    expect(rtl.screen.getByText(/9999.50 XLM/)).toBeTruthy();
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
    test("a node of a kind this client does not know renders as a generic node", () => {
      const node = buildSceneNode({ id: "vault:1", kind: "vault", label: "Vault" }, 0);
      expect(node.kind).toBe("generic");
      rtl.render(<OrbitalNode node={{ ...node, status: "docked" }} />);
      expect(rtl.screen.getByText("Vault")).toBeTruthy();
    });

    test("an allowance node keeps its kind and draws its label and amount", () => {
      const node = buildSceneNode({ id: "allowance:1", kind: "allowance", label: "Spender 1" }, 0);
      expect(node.kind).toBe("allowance");
      rtl.render(<OrbitalNode node={{ ...node, status: "docked", balance: "10" }} />);
      expect(rtl.screen.getByText("Spender 1")).toBeTruthy();
      expect(rtl.screen.getByText("10")).toBeTruthy();
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
