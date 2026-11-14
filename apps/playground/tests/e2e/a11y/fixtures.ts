import { expect, type Page, type Route } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { getMessPlanForMode } from "../../../lib/mess-plan";

// The playground's own routes, answered in the browser: nothing is funded, signed or sent, and
// the server only serves the page.

export const BASE = "http://localhost:3002";
export const SESSION_ID = "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01";
// Not key-shaped on purpose: no strkey and no hex run.
export const SECRET_PLACEHOLDER = "demo-secret-placeholder";

const MINUTE = 60_000;

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

export interface PlaygroundRoutes {
  /** Overrides one route by its path under /api, e.g. `/session/<id>/mess`. */
  set: (path: string, reply: () => Reply) => void;
  /** Fails the test if the page called a route no fixture answers. */
  expectAllAnswered: () => void;
}

const demo = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const sink = Keypair.random().publicKey();

const accountState = (numSubEntries: number) => ({
  address: demo,
  network: "testnet",
  nativeBalanceLumens: "9999.5",
  numSubEntries,
  numSponsoring: 0,
  signers: [{ type: "ed25519_public_key", key: demo, weight: 1 }],
  thresholds: { low: 0, med: 0, high: 0 },
  openOffers: [],
});

export const MERGE = {
  txId: "tx-merge",
  hash: "e2e-merge-transaction",
  summary: "Close the account",
  operations: [{ type: "account_merge", destination: sink, source: demo }],
};

/** Answers every playground route for a light demo whose countdown ends `minutesLeft` from now. */
export async function answerRoutes(page: Page, minutesLeft = 60): Promise<PlaygroundRoutes> {
  const plan = getMessPlanForMode("light");
  const unanswered: string[] = [];
  let done = 0;
  const replies = new Map<string, () => Reply>([
    ["/scenarios", () => ({ status: 200, body: { unavailable: [] } })],
    [
      "/session",
      () => ({
        status: 200,
        body: {
          sessionId: SESSION_ID,
          demoPublic: demo,
          expiresAt: Date.now() + minutesLeft * MINUTE,
          messPlan: plan,
          accounts: {
            issuer,
            mm: sink,
            lwdemoAsset: `LWDEMO:${issuer}`,
            ephemeral: [],
            transferRecipient: null,
            helpers: [],
            exchange: null,
          },
        },
      }),
    ],
    [
      `/session/${SESSION_ID}/mess`,
      () => {
        done++;
        return { status: 200, body: { txHash: null } };
      },
    ],
    [
      `/session/${SESSION_ID}/state`,
      () => ({
        status: 200,
        body: {
          demoPublic: demo,
          accountState: accountState(done),
          completedMessSteps: [],
          demolishLog: [],
          demolishDone: false,
        },
      }),
    ],
    [`/session/${SESSION_ID}/sdk-snippet`, () => ({ status: 404, body: {} })],
    [
      `/session/${SESSION_ID}/credentials`,
      () => ({ status: 200, body: { publicKey: demo, secretKey: SECRET_PLACEHOLDER } }),
    ],
    [
      `/session/${SESSION_ID}/demolish/round`,
      () => ({ status: 200, body: { done: true, confirmed: [MERGE], remainingSteps: 0 } }),
    ],
    [`/session/${SESSION_ID}/cleanup`, () => ({ status: 200, body: { ok: true } })],
  ]);

  await page.route(
    (url) => url.origin === BASE && url.pathname.startsWith("/api/"),
    async (route: Route) => {
      const path = new URL(route.request().url()).pathname.slice("/api".length);
      const reply = replies.get(path);
      if (!reply) unanswered.push(`${route.request().method()} ${path}`);
      const { status, body } = reply ? await reply() : { status: 500, body: {} };
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    }
  );
  return {
    set: (path, reply) => void replies.set(path, reply),
    expectAllAnswered: () => expect(unanswered, "API calls with no fixture").toEqual([]),
  };
}

/** Starts the demo and waits until the panel offers the close. */
export async function runSetup(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  await page.getByRole("button", { name: "Demolish it here" }).waitFor();
}
