import { test, expect, type Page, type Route } from "@playwright/test";
import {
  Account,
  Asset,
  Claimant,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  CLOSE_FINISHED_URL,
  enterDestinationAndBegin,
  enterSecretKey,
  enterSourceAddress,
  enterSourceAndAnalyze,
  expectSigningPanel,
  openTestnetHome,
  TESTNET_STEP_TIMEOUT,
} from "./helpers/flow";
import { connectStubWallet, installWalletStub } from "./helpers/wallet-stub";

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

/** The visible alerts and status messages, minus Next's route announcer, which only repeats the
 *  page title. */
async function messageTexts(page: Page): Promise<string[]> {
  return page
    .locator(':is([role="alert"], [role="status"]):not(next-route-announcer *)')
    .allInnerTexts()
    .then((texts) => texts.map((t) => t.trim()).filter(Boolean));
}

// The claims no screen may make once a transaction of the close could have landed, as the
// registry in lib/journey/claims.ts reads them.
const FALSE_ONCE_SIGNING =
  /nothing (?:has been|was|is) (?:signed or )?sent|no transaction (?:has been|was) sent|account is unchanged|account is closed|account (?:successfully )?merged/i;

async function expectNoFalseClaim(page: Page): Promise<void> {
  expect(await page.locator("main").innerText()).not.toMatch(FALSE_ONCE_SIGNING);
}

async function submitOps(kp: Keypair, ops: xdr.Operation[]): Promise<void> {
  const account = (await (await fetch(`${HORIZON}/accounts/${kp.publicKey()}`)).json()) as {
    sequence: string;
  };
  const builder = new TransactionBuilder(new Account(kp.publicKey(), account.sequence), {
    fee: "1000",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(120);
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.build();
  tx.sign(kp);
  const res = await fetch(`${HORIZON}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tx: tx.toEnvelope().toXdr("base64") }),
  });
  if (!res.ok) throw new Error(`setup transaction failed: ${await res.text()}`);
}

async function expectPlainCopy(
  page: Page,
  expected: RegExp,
  raw: string,
  role: "alert" | "status" = "alert"
): Promise<void> {
  const message = page.locator(`[role="${role}"]`).filter({ hasText: expected });
  await expect(message.first()).toBeVisible({ timeout: TESTNET_STEP_TIMEOUT });
  for (const text of await messageTexts(page)) {
    expect(text).not.toMatch(RAW_LEAK);
    expect(text).not.toContain(raw);
  }
}

async function analyzeFromHome(page: Page): Promise<void> {
  await openTestnetHome(page);
  await enterSourceAddress(page, source.publicKey());
  await page.getByRole("button", { name: /Analyze account/i }).click();
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

    const begin = page.getByRole("button", { name: /Review the full plan/i });
    // The destination field is on screen from the start; the button unlocks once every item is decided.
    await expect(page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/)).toBeVisible({
      timeout: TESTNET_STEP_TIMEOUT,
    });
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
    role?: "status";
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
      copy: /not confirmed yet/,
      role: "status",
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
      await expectPlainCopy(page, c.copy, c.raw, c.role);
      await expectNoFalseClaim(page);
    });
  }

  test("a close the service cannot finish reads as plain copy", async ({ page }) => {
    test.setTimeout(180_000);
    await toSigning(page);
    await page.route("**/api/v1/testnet/close/transactions", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          planHash: "h",
          status: "ready",
          transactions: [],
          remaining: { steps: 2, requiresAnotherCall: true },
        }),
      })
    );
    await sign(page);
    await expectPlainCopy(page, /picks up where it stopped/, "CloseDidNotConvergeError");
  });

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
  async function toWalletSigning(page: Page, from: Keypair, to: Keypair): Promise<void> {
    await enterSourceAndAnalyze(page, from.publicKey());
    await enterDestinationAndBegin(page, to.publicKey());
    await connectStubWallet(page);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Sign & execute close/i }).click();
  }

  test("a wallet rejection reads as a declined request, not the wallet's wording", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // Read from the wallet's code, -4, not its wording: this text says nothing about declining.
    const raw = "Request refused by the extension (0x6985)";
    await installWalletStub(page, {
      address: source.publicKey(),
      sign: { kind: "reject", code: -4, message: raw },
    });
    await toWalletSigning(page, source, destination);

    await expectPlainCopy(page, /declined the request in your wallet/, raw);
  });

  test("a wallet that approves signs the close and it completes", async ({ page }) => {
    test.setTimeout(300_000);
    // Its own accounts: this close really merges, and the suite's shared source must survive it.
    const owner = Keypair.random();
    const receiver = Keypair.random();
    await Promise.all([fund(owner.publicKey()), fund(receiver.publicKey())]);
    const wallet = await installWalletStub(page, {
      address: owner.publicKey(),
      sign: { kind: "approve", keypair: owner },
    });
    await toWalletSigning(page, owner, receiver);

    await expect(page).toHaveURL(CLOSE_FINISHED_URL, { timeout: 90_000 });
    expect(wallet.signRequests.length).toBeGreaterThan(0);
    for (const request of wallet.signRequests) {
      expect(request.networkPassphrase).toBe(Networks.TESTNET);
    }
    expect((await fetch(`${HORIZON}/accounts/${owner.publicKey()}`)).status).toBe(404);
  });

  test("a wallet that never answers is given up on with plain copy, and Retry and Change wallet or key", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // Real time keeps flowing; fastForward only jumps it past the two-minute signing timeout.
    await page.clock.install();
    const wallet = await installWalletStub(page, {
      address: source.publicKey(),
      sign: { kind: "never" },
    });
    await toWalletSigning(page, source, destination);

    await wallet.waitForSignRequest(TESTNET_STEP_TIMEOUT);
    await expect(
      page.locator('[role="status"]').filter({ hasText: /approve in your wallet/ })
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Sign & execute close/i })).toHaveCount(0);

    await page.clock.fastForward("02:01");
    await expectPlainCopy(page, /Your wallet didn't respond in time/, "SUBMIT_TRANSACTION");
    await expect(page.getByText(/this transaction was not signed or sent/)).toBeVisible();
    await expect(page.getByText(/Close the earlier prompt in your wallet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Change wallet or key" })).toBeVisible();
    // The stub never answers the first prompt, so Retry is held for its 5 s, then offered.
    const retry = page.getByRole("button", { name: "Retry" });
    await expect(retry).toBeDisabled();
    await expect(retry).toBeEnabled({ timeout: 15_000 });
    expect(wallet.signRequests).toHaveLength(1);
  });
});

test.describe("wallet state checked before signing", () => {
  async function toWalletReady(page: Page): Promise<void> {
    await enterSourceAndAnalyze(page, source.publicKey());
    await enterDestinationAndBegin(page, destination.publicKey());
    await connectStubWallet(page);
  }

  test("an account switch after connecting is caught when the tab regains focus", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.clock.install();
    const other = Keypair.random();
    const wallet = await installWalletStub(page, {
      address: source.publicKey(),
      sign: { kind: "approve", keypair: source },
    });
    await toWalletReady(page);

    wallet.set({ address: other.publicKey(), sign: { kind: "approve", keypair: other } });
    // Past the 5 s between re-checks, then back to the tab.
    await page.clock.fastForward("00:06");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));

    await expect(page.getByRole("button", { name: "Reconnect wallet" })).toBeVisible({
      timeout: TESTNET_STEP_TIMEOUT,
    });
    await expect(page.getByText(/Connected:/)).toHaveCount(0);
    await page.getByRole("checkbox").check();
    await expect(page.getByRole("button", { name: /Sign & execute close/i })).toBeDisabled();
    expect(wallet.signRequests).toHaveLength(0);
  });

  test("a wallet that signs with another account is refused with the account named", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const other = Keypair.random();
    const wallet = await installWalletStub(page, {
      address: source.publicKey(),
      sign: { kind: "approve", keypair: source },
    });
    await toWalletReady(page);
    let submits = 0;
    await page.route("**/api/v1/testnet/submit", (route) => {
      submits++;
      return route.abort("failed");
    });

    // The account switches inside the wallet, with no event the page could see.
    wallet.set({ sign: { kind: "approve", keypair: other } });
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /Sign & execute close/i }).click();

    const short = `${other.publicKey().slice(0, 4)}…${other.publicKey().slice(-4)}`;
    await expectPlainCopy(
      page,
      new RegExp(`Your wallet signed with a different account \\(${short}\\)`),
      "SUBMIT_TRANSACTION"
    );
    await expect(
      page.getByRole("button", { name: "Disconnect and choose another wallet" })
    ).toBeVisible();
    await expect(page.getByRole("list", { name: "Keys that can sign" })).toContainText(
      source.publicKey().slice(-4)
    );
    expect(wallet.signRequests).toHaveLength(1);
    expect(submits).toBe(0);
  });

  test("a wallet on another network is blocked before any prompt", async ({ page }) => {
    test.setTimeout(180_000);
    const wallet = await installWalletStub(page, {
      address: source.publicKey(),
      network: "PUBLIC",
      sign: { kind: "approve", keypair: source },
    });
    await toWalletReady(page);

    await expect(
      page.getByText(/Your wallet is on a different network than this page/)
    ).toBeVisible();
    await page.getByRole("checkbox").check();
    const sign = page.getByRole("button", { name: /Sign & execute close/i });
    await expect(sign).toBeDisabled();
    await sign.click({ force: true });
    expect(wallet.signRequests).toHaveLength(0);
  });
});

test.describe("a close stopped part way", () => {
  test("a failure after a confirmed round states what is done and claims nothing false", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // A claimable balance of a throwaway asset forces a claim round before the merge round. The
    // claim round is really confirmed; the merge round's build is then refused at the proxy.
    const owner = Keypair.random();
    const issuer = Keypair.random();
    const receiver = Keypair.random();
    await Promise.all([fund(owner.publicKey()), fund(issuer.publicKey())]);
    await fund(receiver.publicKey());
    const asset = new Asset("PART", issuer.publicKey());
    await submitOps(issuer, [
      Operation.createClaimableBalance({
        asset,
        amount: "5",
        claimants: [new Claimant(owner.publicKey())],
      }),
    ]);

    await enterSourceAndAnalyze(page, owner.publicKey());
    // Each group opens on its own when it holds a decision that was not there before.
    await page.getByRole("radio", { name: /Add a PART trustline and claim it/ }).check();
    // The claim answer re-plans, and only the new plan asks what happens to the claimed PART.
    const giveBack = page.getByRole("radio", { name: /Return my .*PART to the issuer/ });
    await giveBack.check({ timeout: TESTNET_STEP_TIMEOUT });
    await enterDestinationAndBegin(page, receiver.publicKey());
    await expectSigningPanel(page);
    await enterSecretKey(page, owner.secret());
    await page.getByRole("checkbox").check();

    let builds = 0;
    const raw = "upstream request timed out after 30000ms";
    await page.route("**/api/v1/testnet/close/transactions", (route) =>
      ++builds === 1 ? route.continue() : failWith(503, raw)(route)
    );
    await page.getByRole("button", { name: /Sign & execute close/i }).click();

    await expectPlainCopy(
      page,
      /\d+ of \d+ plan steps are already confirmed, so your account is partly closed and still open/,
      raw
    );
    await expect(page.getByText(/No new transaction was sent/)).toBeVisible();
    await expectNoFalseClaim(page);
    expect(builds).toBe(2);
  });
});
