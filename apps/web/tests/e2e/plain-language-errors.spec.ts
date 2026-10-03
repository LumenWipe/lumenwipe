import { test, expect, type Page, type Route } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  enterDestinationAndBegin,
  enterSecretKey,
  enterSourceAddress,
  enterSourceAndAnalyze,
  openTestnetHome,
  expectSigningPanel,
  TESTNET_STEP_TIMEOUT,
} from "./helpers/flow";

// Every failure here is injected at the proxy boundary, so nothing is ever submitted and one
// funded account serves every case. What is asserted is the copy the user reads: it must be the
// plain-language mapping from lib/utils/user-error.ts, and none of the raw text the failure
// carried may reach the screen.
//
// Testnet only, per repo rules.

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";

const RAW_LEAK =
  /\b(tx|op)_[a-z_]+\b|\b\w*(Error|Exception)\b|HostFunction|RPC_ERROR|\bat \S+ \(|\(\d{3}\)|LumenWipe API|Request failed|undefined|\[object/;

async function fund(pub: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`);
  if (!res.ok) throw new Error(`friendbot ${res.status}: ${await res.text()}`);
  for (let i = 0; i < 10; i++) {
    if ((await fetch(`${HORIZON}/accounts/${pub}`)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`account ${pub} was not indexed in time`);
}

function failWith(status: number, rawMessage: string) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UPSTREAM", message: rawMessage } }),
    });
}

/** The visible alerts, minus Next's route announcer, which only repeats the page title. */
async function alertTexts(page: Page): Promise<string[]> {
  return page
    .locator('[role="alert"]:not(next-route-announcer *)')
    .allInnerTexts()
    .then((texts) => texts.map((t) => t.trim()).filter(Boolean));
}

async function expectPlainCopy(page: Page, expected: RegExp, raw: string): Promise<void> {
  const alert = page.locator('[role="alert"]').filter({ hasText: expected });
  await expect(alert.first()).toBeVisible({ timeout: TESTNET_STEP_TIMEOUT });
  for (const text of await alertTexts(page)) {
    expect(text).not.toMatch(RAW_LEAK);
    expect(text).not.toContain(raw);
  }
}

async function analyzeFromHome(page: Page): Promise<void> {
  await openTestnetHome(page);
  await enterSourceAddress(page, source.publicKey());
  await page.getByRole("button", { name: /Analyze account/i }).click();
}

// Stands in for the Freighter extension at the one seam the real one uses: window.postMessage.
// The kit and @stellar/freighter-api run unmodified; only the extension's answers are scripted.
async function installFreighterStub(page: Page, address: string): Promise<void> {
  await page.addInitScript((addr) => {
    const network = {
      network: "TESTNET",
      networkUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    };
    const answers: Record<string, Record<string, unknown>> = {
      REQUEST_CONNECTION_STATUS: { isConnected: true },
      REQUEST_ALLOWED_STATUS: { isAllowed: true },
      SET_ALLOWED_STATUS: { isAllowed: true },
      REQUEST_ACCESS: { publicKey: addr },
      REQUEST_PUBLIC_KEY: { publicKey: addr },
      REQUEST_NETWORK_DETAILS: { networkDetails: network },
      REQUEST_NETWORK: { network: "TESTNET", networkPassphrase: network.networkPassphrase },
      SUBMIT_TRANSACTION: {
        signedTransaction: "",
        apiError: { code: -4, message: "The user rejected this request." },
      },
    };
    window.addEventListener("message", (event) => {
      const data = event.data as { source?: string; messageId?: number; type?: string } | null;
      if (event.source !== window || data?.source !== "FREIGHTER_EXTERNAL_MSG_REQUEST") return;
      window.postMessage(
        {
          source: "FREIGHTER_EXTERNAL_MSG_RESPONSE",
          messagedId: data.messageId,
          ...(answers[data.type ?? ""] ?? {}),
        },
        window.location.origin
      );
    });
  }, address);
}

let source: Keypair;
let destination: Keypair;

test.beforeAll(async () => {
  source = Keypair.random();
  destination = Keypair.random();
  await fund(source.publicKey());
  await fund(destination.publicKey());
});

test.describe("analyze", () => {
  test("a failing account read shows plain copy, not the API's raw message", async ({ page }) => {
    const raw = "HostFunctionError: op_underfunded at rpc.simulate (host.rs:42)";
    await page.route("**/api/testnet/account/**", failWith(500, raw));
    await analyzeFromHome(page);
    await expectPlainCopy(page, /temporarily unavailable/, raw);
  });

  test("a dropped connection while analyzing reads as a connection problem", async ({ page }) => {
    await page.route("**/api/testnet/account/**", (route) => route.abort("failed"));
    await analyzeFromHome(page);
    await expectPlainCopy(page, /Failed to connect to the Stellar network/, "net::ERR_FAILED");
  });

  test("an unknown account reads as not found, not as the API's wording", async ({ page }) => {
    const raw = "AccountNotFoundError: horizon 404 at loadAccount (account.ts:9:1)";
    await page.route("**/api/testnet/account/**", failWith(404, raw));
    await analyzeFromHome(page);
    await expectPlainCopy(page, /couldn't find that on this network/, raw);
  });

  test("a failing plan build shows plain copy", async ({ page }) => {
    const raw = "BuilderError: tx_bad_seq while assembling plan";
    await page.route("**/api/v1/testnet/close/plan", failWith(500, raw));
    await enterSourceAndAnalyze(page, source.publicKey());
    await expectPlainCopy(page, /Failed to analyze account/, raw);
  });
});

test.describe("review", () => {
  test("a failing destination check shows plain copy", async ({ page }) => {
    const raw = "Mediator check failed with status 500: ECONNREFUSED 10.0.0.4:5432";
    await page.route("**/api/testnet/mediator/check/**", failWith(500, raw));
    await enterSourceAndAnalyze(page, source.publicKey());

    const begin = page.getByRole("button", { name: /Begin execution/i });
    await expect(begin).toBeVisible({ timeout: TESTNET_STEP_TIMEOUT });
    await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination.publicKey());
    await page.getByRole("checkbox", { name: /wallet I control/i }).check();
    await begin.click();

    await expectPlainCopy(page, /Failed to verify the destination/, raw);
  });
});

test.describe("execute with a secret key", () => {
  async function toSigning(page: Page): Promise<void> {
    await enterSourceAndAnalyze(page, source.publicKey());
    await enterDestinationAndBegin(page, destination.publicKey());
    await expectSigningPanel(page);
    await enterSecretKey(page, source.secret());
    await page.getByRole("checkbox").check();
  }

  async function sign(page: Page): Promise<void> {
    await page.getByRole("button", { name: /Sign & execute close/i }).click();
  }

  const cases: Array<{
    name: string;
    endpoint: string;
    status: number;
    raw: string;
    copy: RegExp;
  }> = [
    {
      name: "simulation failure",
      endpoint: "**/api/v1/testnet/close/transactions",
      status: 422,
      raw: "simulation failed: HostFunctionError(WasmVm, InvalidAction) op_underfunded",
      copy: /The close could not be completed/,
    },
    {
      name: "gateway timeout",
      endpoint: "**/api/v1/testnet/close/transactions",
      status: 504,
      raw: "upstream request timed out after 30000ms",
      copy: /temporarily unavailable/,
    },
    {
      name: "service error",
      endpoint: "**/api/v1/testnet/close/transactions",
      status: 502,
      raw: "Bad Gateway: connect ECONNREFUSED 127.0.0.1:3001",
      copy: /temporarily unavailable/,
    },
    {
      name: "rate limit",
      endpoint: "**/api/v1/testnet/close/transactions",
      status: 429,
      raw: "ThrottlerException: Too Many Requests",
      copy: /Too many requests/,
    },
    {
      name: "failed submit",
      endpoint: "**/api/v1/testnet/submit",
      status: 500,
      raw: "tx_internal_error: submission failed (500)",
      copy: /temporarily unavailable/,
    },
    {
      name: "unmapped status falls back instead of leaking",
      endpoint: "**/api/v1/testnet/close/transactions",
      status: 418,
      raw: "RPC_ERROR_-32602: tx_bad_seq at Server.send (rpc.js:1:2)",
      copy: /The close could not be completed/,
    },
  ];

  for (const c of cases) {
    test(c.name, async ({ page }) => {
      test.setTimeout(180_000);
      await toSigning(page);
      await page.route(c.endpoint, failWith(c.status, c.raw));
      await sign(page);
      await expectPlainCopy(page, c.copy, c.raw);
    });
  }

  test("a dropped connection while building the close reads as a connection problem", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await toSigning(page);
    await page.route("**/api/v1/testnet/close/transactions", (route) => route.abort("failed"));
    await sign(page);
    await expectPlainCopy(page, /check your connection and try again/, "Failed to fetch");
  });
});

test.describe("execute with a wallet", () => {
  test("a wallet rejection reads as a declined request, not the wallet's wording", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installFreighterStub(page, source.publicKey());
    await enterSourceAndAnalyze(page, source.publicKey());
    await enterDestinationAndBegin(page, destination.publicKey());

    await page
      .getByRole("button", { name: /Connect wallet/i })
      .last()
      .click();
    await page.getByText("Freighter", { exact: true }).click();
    await expect(page.getByText(/Connected:/)).toBeVisible({ timeout: TESTNET_STEP_TIMEOUT });

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Sign & execute close/i }).click();

    await expectPlainCopy(page, /declined the request in your wallet/, "The user rejected");
  });
});
