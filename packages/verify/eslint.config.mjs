import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

// The facade may reach into apps/web for exactly four modules: the three that make up the
// verifier, and the allowance-revocation anchor, which imports only the intent decoder the
// verifier already bundles. The exchange registry reaches the bundle through the verifier;
// tests/bundle.test.ts fails if the served-registry fetch is ever bundled. Anything else would turn this package into a second
// copy of web code, or pull in web code that reads the network or the page.
const WEB_ALLOWED = [
  "../../../apps/web/lib/stellar/verify",
  "../../../apps/web/lib/stellar/exit-expectations",
  "../../../apps/web/lib/stellar/verification-error",
  "../../../apps/web/lib/stellar/verify-revoke-allowance",
];

const config = [
  { ignores: ["dist/**", "dist-types/**", "node_modules/**"] },
  js.configs.recommended,
  ...tsPlugin.configs["flat/recommended"],
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^(?!(?:\\.\\./\\.\\./\\.\\./apps/web/lib/(?:stellar/(?:verify|exit-expectations|verification-error|verify-revoke-allowance)))$)(?:\\.\\./)+apps/",
              message: `Only these web modules may be imported: ${WEB_ALLOWED.join(", ")}.`,
            },
            {
              regex: "^@/|^@registry/",
              message: "Reach the web by relative path, and only through the four allowed modules.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
