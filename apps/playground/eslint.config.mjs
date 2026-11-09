import coreWebVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier";

const appPatterns = [
  {
    group: [
      "@/lib/stellar/tx-builder",
      "@/lib/stellar/tx-builder/*",
      "@/lib/close-api",
      "@/lib/close-api/*",
    ],
    message:
      "apps/playground never re-implements closing logic. Mess-building lives in ./lib directly; closing goes through @lumenwipe/sdk's runClose against the real API.",
  },
  {
    group: ["@lumenwipe/api", "@lumenwipe/api/*", "@lumenwipe/web", "@lumenwipe/web/*"],
    message: "apps/playground must not import apps/api or apps/web directly.",
  },
  {
    group: ["**/apps/web", "**/apps/web/**", "**/../web/**"],
    message:
      "apps/playground verifies with @lumenwipe/verify, the published build of the web's trust anchor, never by reaching into apps/web.",
  },
];

const restrict = (...extra) => ({
  "no-restricted-imports": ["error", { patterns: [...appPatterns, ...extra] }],
});

// The scenario registry is isomorphic (it runs in the browser and on the server), and the executors
// and the verifier never import each other: verification reads only the close expectation and the
// transaction.
const registryPatterns = [
  {
    group: ["server-only", "@stellar/stellar-sdk", "node:*", "**/mess-builders", "**/verify"],
    message:
      "lib/scenarios is isomorphic: no server-only code, no Stellar SDK, no I/O, no executor or verifier.",
  },
];

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...coreWebVitals,
  prettier,
  { rules: restrict() },
  { files: ["lib/scenarios/**"], rules: restrict(...registryPatterns) },
  {
    files: ["lib/verify.ts"],
    rules: restrict({
      group: ["**/mess-builders"],
      message: "The verifier never imports the mess executors.",
    }),
  },
  {
    files: ["lib/mess-builders.ts"],
    rules: restrict({
      group: ["**/verify", "@lumenwipe/verify"],
      message: "The mess executors never import the verifier.",
    }),
  },
];

export default config;
