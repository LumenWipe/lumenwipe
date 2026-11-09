import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { IntentOperation } from "@lumenwipe/sdk";
import { errorCopy } from "@/lib/error-copy";
import { getMessPlanForMode } from "@/lib/mess-plan";
import { usePlaygroundStore } from "@/store/playground";
import { usePlaygroundExecution } from "@/hooks/usePlaygroundExecution";
import PlaygroundControls from "@/components/scene/PlaygroundControls";
import TxLogPanel from "@/components/scene/TxLogPanel";

// The demolish as the visitor sees it: the hook, the control panel and the activity log, against
// a fake of the playground's own routes. Each round's confirmed transactions must reach the scene
// and the log as that round returns, and an error part way through must offer a resume, with a
// warning before "Start over" abandons the account.

// The DOM is registered for this file only, and removed after it, so the rest of the suite keeps
// Bun's own globals. @testing-library/react reads `document` when it loads, hence the dynamic
// import after registering.
GlobalRegistrator.register();
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
    accountState: { nativeBalanceLumens: "9999.5", numSubEntries: 1 },
    completedMessSteps: [],
    demolishLog: [],
    demolishDone: false,
  };

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${path}`);
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
  const { start, demolish, progressStatus } = usePlaygroundExecution();
  return (
    <>
      <PlaygroundControls start={start} demolish={demolish} progressStatus={progressStatus} />
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

  test("an error before the close started keeps the single Start over, with no warning", async () => {
    routes.handlers.set("/api/session", async () => ({
      status: 502,
      body: { error: "friendbot_failed" },
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
