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
];

// Playground code may import only its own source and packages/*, with no exception.
const appZones = {
  "import/no-restricted-paths": [
    "error",
    {
      basePath: import.meta.dirname,
      zones: [
        {
          target: "./",
          from: "../web",
          message:
            "apps/playground verifies with @lumenwipe/verify, the published build of the web's trust anchor, never by reaching into apps/web.",
        },
        {
          target: "./",
          from: "../api",
          message:
            "apps/playground must not import apps/api source. It closes through @lumenwipe/sdk against the real API.",
        },
      ],
    },
  ],
};

// The verifier checks what the API built and never builds a transaction itself.
const NOT_BUILT_HERE =
  "The playground's verifier never builds a transaction: it parses and checks what the API built (TransactionBuilder.fromXDR is fine).";
const STELLAR_SDK = "/^@stellar\\/stellar-(?:sdk|base)(?:\\/|$)/";

const verifierBuilds = [
  "NewExpression[callee.name='TransactionBuilder']",
  "MemberExpression[object.name='TransactionBuilder'][property.name=/^(?:buildFeeBumpTransaction|cloneFrom)$/]",
  "ImportSpecifier[imported.name='TransactionBuilder'][local.name!='TransactionBuilder']",
  `ImportDeclaration[source.value=${STELLAR_SDK}] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)`,
  `ImportExpression[source.value=${STELLAR_SDK}]`,
  "NewExpression[callee.object.name='xdr'][callee.property.name=/^(?:Transaction|TransactionV0|TransactionV1Envelope|TransactionV0Envelope|FeeBumpTransaction|FeeBumpTransactionEnvelope|Operation)$/]",
  "MemberExpression[object.object.name='xdr'][object.property.name='TransactionEnvelope'][property.name=/^envelopeType/]",
  "MemberExpression[object.object.name='xdr'][object.property.name='OperationBody']:not([property.name='fromXDR'])",
].map((selector) => ({ selector, message: NOT_BUILT_HERE }));

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
  { files: ["**/*.{ts,tsx}"], rules: { "@typescript-eslint/no-explicit-any": "error" } },
  { rules: { ...restrict(), ...appZones } },
  { files: ["lib/scenarios/**"], rules: restrict(...registryPatterns) },
  {
    files: ["lib/verify*.ts"],
    rules: restrict({
      group: ["**/mess-builders", "**/soroban-seed", "**/soroban-submit", "**/horizon-submit"],
      message:
        "The verifier never imports the mess executors, the seeding they use, or the code that submits a transaction.",
    }),
  },
  {
    files: ["lib/verify*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...verifierBuilds],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@stellar/stellar-sdk", "@stellar/stellar-sdk/*"],
              importNames: [
                "Operation",
                "Account",
                "MuxedAccount",
                "Contract",
                "SorobanDataBuilder",
              ],
              allowTypeImports: true,
              message: NOT_BUILT_HERE,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/mess-builders.ts", "lib/soroban-seed.ts", "lib/soroban-submit.ts"],
    rules: restrict({
      group: ["**/verify", "**/verify-*", "@lumenwipe/verify"],
      message: "The mess executors and their seeding never import the verifier.",
    }),
  },
];

export default config;
