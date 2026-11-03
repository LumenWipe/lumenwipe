import coreWebVitals from "eslint-config-next/core-web-vitals";
import prettier from "eslint-config-prettier";

const CLASS_START = `(^|[\\s:"'\`])(?:[a-z0-9-]+:)*`;

/** Flags a class in string literals and in template literal chunks, whose text is `value.raw`. */
function bannedClass(pattern, message) {
  const regex = `${CLASS_START}${pattern}`;
  return ["Literal[value", "TemplateElement[value.raw"].map((attribute) => ({
    selector: `${attribute}=/${regex}/]`,
    message,
  }));
}

const dimWhiteText = bannedClass(
  "text-white\\/(?:[0-4][0-9]|5[0-5]|[0-9])(?![\\w\\/\\[-])",
  "Readable text must use text-fg, text-fg-muted or text-fg-subtle (text-fg-disabled for decorative or disabled elements), not a white opacity at or below 55."
);

const COLOR_UTILITY =
  "-?(?:text|bg|border|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent|shadow)";
const PALETTE =
  "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";

const rawStyling = [
  ...bannedClass(
    "text-destructive(?![\\w-])",
    "text-destructive is a fill color. Use text-danger-fg for error text and icons."
  ),
  ...bannedClass(
    `${COLOR_UTILITY}-${PALETTE}-[0-9]{2,3}(?![\\w-])`,
    "Raw palette colors bypass the tokens. Use the semantic color: danger, warning, success, accent or value, and fg, line or surface for neutrals."
  ),
  ...bannedClass(
    `${COLOR_UTILITY}-stellar(?![\\w-])`,
    "stellar was a transitional alias and is gone. Use accent, and text-accent-fg for text on an accent fill."
  ),
  ...bannedClass(
    "text-black(?![\\w-])",
    "Text on a filled background uses its pair token: text-accent-fg on bg-accent, text-warning-fg on bg-warning, text-danger-on-fill on bg-danger."
  ),
  ...bannedClass(
    "text-\\[(?:length:)?(?:[0-9.]|clamp\\(|calc\\(|min\\(|max\\()",
    "Arbitrary text sizes drift from the type scale. Use text-caption (11px), text-label (12px), text-body-sm, text-body, text-title, text-heading, text-display or text-hero."
  ),
];

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...coreWebVitals,
  prettier,
  {
    rules: {
      // React Compiler rules new in eslint-config-next 16; the close flow's effects predate them and are not rewritten blind.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/lib/stellar/tx-builder",
                "@/lib/stellar/tx-builder/*",
                "@/lib/stellar/step-engine",
                "@/lib/stellar/fast-path",
                "@/lib/stellar/submit",
                "@/lib/stellar/account",
                "@/lib/stellar/account-state",
                "@/lib/stellar/horizon-adapter",
                "@/lib/stellar/horizon-http",
                "@/lib/stellar/path-finding",
                "@/lib/stellar/scan-fallback",
                "@/lib/stellar/rpc",
                "@/lib/stellar/mediator-server",
                "@/lib/close-api",
                "@/lib/close-api/*",
              ],
              message:
                "Account-closing logic lives in the API. Reach the backend through @lumenwipe/sdk (via the /api proxy routes), never a local closing module.",
            },
            {
              group: ["@lumenwipe/api", "@lumenwipe/api/*"],
              message: "The web must not import apps/api directly. Use @lumenwipe/sdk.",
            },
            {
              group: ["@lumenwipe/playground", "@lumenwipe/playground/*"],
              message:
                "apps/web must not import apps/playground. It is isolated on purpose - its custodial demo-account code must never reach production.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: ["components/ui/**"],
    rules: { "no-restricted-syntax": ["error", ...dimWhiteText, ...rawStyling] },
  },
  {
    files: ["components/ui/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...dimWhiteText] },
  },
  {
    files: ["tests/**/*.ts", "tests/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='mock'][callee.property.name='module']",
          message:
            "mock.module replaces a module for the whole `bun test` process and leaks into other test files depending on file order (it turned CI red on 2026-09-02). Patch the real module object with spyOn(...).mockImplementation(...) and undo it with mock.restore() in afterEach, or inject the dependency.",
        },
      ],
    },
  },
];

export default config;
