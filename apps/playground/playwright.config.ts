import { defineConfig, devices } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

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
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry: each attempt funds fresh testnet accounts, and a second failure is a real one.
  retries: process.env.CI ? 1 : 0,
  // Stops the run inside the nightly job's 90-minute limit, so a slow night ends as a failed run
  // with its report (which files the tracking issue) rather than a runner kill reported as
  // cancelled. The per-test budgets sum to about 89 minutes; a healthy run takes far less.
  globalTimeout: process.env.CI ? 80 * 60_000 : undefined,
  // The github reporter writes no report directory on its own, so it is paired with html to give
  // the nightly something to upload.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
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
      command: "bun run dev:api",
      cwd: "../..",
      env: {
        FEE_ACCOUNT_SECRET_TESTNET: feeAccount.secret(),
        MEDIATOR_SECRET_TESTNET: mediator.secret(),
        MEDIATOR_PUBLIC_TESTNET: mediator.publicKey(),
      },
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
