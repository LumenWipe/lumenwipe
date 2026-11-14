import { defineConfig, devices } from "@playwright/test";

// The accessibility gate. Every `/api/**` call is answered by fixtures in the browser, so only
// the playground is started, against its production build, and nothing reaches testnet.
export default defineConfig({
  testDir: "./tests/e2e/a11y",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3002",
    trace: "on-first-retry",
    // Entrance transitions leave text mid-fade, which axe reads as low contrast. Reduced motion
    // renders every element in its final state.
    reducedMotion: "reduce",
  },
  projects: [
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 360, height: 800 } } },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: "bun run start -p 3002",
    url: "http://localhost:3002",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
