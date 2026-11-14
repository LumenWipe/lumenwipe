import { defineConfig, devices } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { JSON_REPORT_PATH } from "./scripts/durations-report";

// The API's fee sponsor for this run only: generated here, so the workers and both servers share
// it, given to the local API as its fee account, and funded by tests/e2e/serve.ts. The playground
// is told only its public key.
process.env.PLAYGROUND_E2E_FEE_SECRET ??= Keypair.random().secret();
const feeAccount = Keypair.fromSecret(process.env.PLAYGROUND_E2E_FEE_SECRET);
// The API's mediator (the relay an exchange close merges into) for this run only, the same way:
// generated here, given to the local API as its mediator key, funded by tests/e2e/serve.ts, and
// named to the playground by its public key alone.
process.env.PLAYGROUND_E2E_MEDIATOR_SECRET ??= Keypair.random().secret();
const mediator = Keypair.fromSecret(process.env.PLAYGROUND_E2E_MEDIATOR_SECRET);

// Testnet only. The playground drives real testnet transactions (Friendbot, Horizon and the real
// API's close loop), so this suite runs nightly and on manual dispatch, never per pull request.
export default defineConfig({
  testDir: "./tests/e2e",
  // Run per pull request by playwright.a11y.config.ts, with every route answered in the browser.
  testIgnore: "a11y/**",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry: each attempt funds fresh testnet accounts, and a second failure is a real one.
  retries: process.env.CI ? 1 : 0,
  // Stops the run inside the nightly job's 90-minute limit, so a slow night ends as a failed run
  // with its report (which files the tracking issue) rather than a runner kill reported as
  // cancelled. The first nightly to run this suite (run 42844639885, 23 tests) is what this
  // limit is for: six tests failed on a setup bug (tx_missing_operation, fixed in #879), each
  // spent its 6-minute wait twice (about 72 minutes), and the run stopped here at 1.3 h with
  // 4 passed and 13 not run. No full run has finished yet, so a healthy duration is still to be
  // measured.
  globalTimeout: process.env.CI ? 80 * 60_000 : undefined,
  // The github reporter writes no report directory on its own, so it is paired with html to give
  // the nightly something to upload. The JSON report carries each test's request timings
  // (tests/e2e/timed.ts) for scripts/durations.ts, inside the uploaded test-results directory.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }], ["json", { outputFile: JSON_REPORT_PATH }]]
    : [["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3002",
    // Kept only for a failed test. No spec calls the credentials route, so a trace never holds a
    // demo secret.
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The demolish goes through the real API, so both services start here.
  webServer: [
    {
      // The API package's own dev script, not the root `dev:api`: that goes through
      // `bun run --filter`, whose rolling status display, under Playwright, repaints its whole
      // window on every line once stdout is kept below.
      command: "bun run dev",
      cwd: "../api",
      env: {
        FEE_ACCOUNT_SECRET_TESTNET: feeAccount.secret(),
        MEDIATOR_SECRET_TESTNET: mediator.secret(),
        MEDIATOR_PUBLIC_TESTNET: mediator.publicKey(),
      },
      // The API's Nest logger writes to stdout, which Playwright drops by default; kept in CI so
      // a throttled upstream is named in the nightly's log (see apps/web/playwright.config.ts).
      stdout: process.env.CI ? "pipe" : "ignore",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Creates this run's testnet accounts, then starts `next dev` (see tests/e2e/serve.ts).
      command: "bun tests/e2e/serve.ts",
      env: {
        PLAYGROUND_EXPECTED_FEE_ACCOUNT_TESTNET: feeAccount.publicKey(),
        PLAYGROUND_EXPECTED_MEDIATOR_TESTNET: mediator.publicKey(),
      },
      url: "http://localhost:3002",
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
