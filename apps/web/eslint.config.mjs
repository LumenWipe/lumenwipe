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

/** Flags a class on the className of a button or link, in a string or template literal. */
function bannedActionClass(pattern, message) {
  const element = "JSXOpeningElement[name.name=/^(?:a|button|Link|Button)$/]";
  const attribute = 'JSXAttribute[name.name="className"]';
  return ["Literal[value", "TemplateElement[value.raw"].map((literal) => ({
    selector: `${element} > ${attribute} ${literal}=/${CLASS_START}${pattern}/]`,
    message,
  }));
}

const goldAction = bannedActionClass(
  "(?:bg|text|border)-value(?![\\w-])",
  "Gold is recovered value only: XLM amounts and totals. A button or link is an action, so it is cyan: use Button, or text-accent for a text link."
);

const MARKETING = [
  "app/(marketing)/**/*.{ts,tsx}",
  "app/(marketing-es)/**/*.{ts,tsx}",
  "app/global-not-found.tsx",
  "app/(app)/not-found.tsx",
  "app/(app)/api-keys/**/*.{ts,tsx}",
  "components/marketing/**/*.{ts,tsx}",
  "components/blog/**/*.{ts,tsx}",
  "lib/i18n/messages/**/*.{ts,tsx}",
];

const marketingTextFloor = bannedClass(
  "text-white\\/(?:5[6-9]|6[0-9])(?![\\w\\/\\[-])",
  "Marketing body text is white at 70 percent or more on the ink. Dimmer text, such as a caption, uses text-fg-muted or text-fg-subtle, the caption floor."
);

const goldFill = bannedClass(
  "text-value-fg(?![\\w-])",
  "text-value-fg is the text on a gold fill, and marketing has no gold control. Use Button for an action."
);

// Files whose user-facing copy is read from the locale dictionary (lib/i18n/messages), and must
// stay that way (docs/contributing/localization.mdx).
export const DICTIONARY_COPY = [
  "app/(marketing)/layout.tsx",
  "app/(marketing)/not-found.tsx",
  "app/(marketing)/page.tsx",
  "app/(marketing)/blog/page.tsx",
  "app/(marketing)/content/page.tsx",
  "app/(marketing)/faq/page.tsx",
  "app/(marketing)/how-it-works/page.tsx",
  "app/(marketing)/playground/page.tsx",
  "app/(marketing)/registry/page.tsx",
  "app/(marketing)/security/page.tsx",
  "app/(marketing)/security/reports/page.tsx",
  "app/(marketing)/stats/page.tsx",
  "app/(marketing-es)/layout.tsx",
  "app/(marketing-es)/es/page.tsx",
  "app/(marketing-es)/es/blog/page.tsx",
  "app/(marketing-es)/es/faq/page.tsx",
  "app/(marketing-es)/es/how-it-works/page.tsx",
  "app/(marketing-es)/es/security/page.tsx",
  "app/(marketing-es)/es/security/reports/page.tsx",
  "app/global-not-found.tsx",
  "components/blog/BaseReserve.tsx",
  "components/blog/BlogIndexPage.tsx",
  "components/blog/BlogToc.tsx",
  "components/blog/CategoryBadge.tsx",
  "components/blog/ContentStatusTable.tsx",
  "components/blog/PostCard.tsx",
  "components/blog/PostDates.tsx",
  "components/blog/PostNextStep.tsx",
  "components/blog/PostPage.tsx",
  "components/blog/RelatedPosts.tsx",
  "components/blog/YouTubeEmbed.tsx",
  "components/marketing/Faq.tsx",
  "components/marketing/FaqAccordion.tsx",
  "components/marketing/FaqPage.tsx",
  "components/marketing/HeroAccountInput.tsx",
  "components/marketing/HeroConsole.tsx",
  "components/marketing/HowItWorksPage.tsx",
  "components/marketing/LandingPage.tsx",
  "components/marketing/LanguageSwitch.tsx",
  "components/marketing/MarketingFooter.tsx",
  "components/marketing/MarketingNav.tsx",
  "components/marketing/MarketingShell.tsx",
  "components/marketing/NotFoundView.tsx",
  "components/marketing/RecoveryEstimate.tsx",
  "components/marketing/SecurityPage.tsx",
  "components/marketing/SecurityReportsPage.tsx",
  "components/marketing/Reveal.tsx",
  "components/marketing/registry/RegistryClient.tsx",
  "components/marketing/stats/AxisLabels.tsx",
  "components/marketing/stats/CalendarHeatmap.tsx",
  "components/marketing/stats/ConstellationChart.tsx",
  "components/marketing/stats/DistributionStrip.tsx",
  "components/marketing/stats/RecentFeed.tsx",
  "components/marketing/stats/StatsClient.tsx",
  "components/marketing/stats/StatsHero.tsx",
  "lib/api/estimate-client.ts",
  "lib/site/navigation.ts",
  "lib/site/numbers.ts",
  "lib/site/pages.ts",
  "lib/site/root-metadata.ts",
  "lib/site/status.ts",
  "lib/site/structured-data.ts",
  "lib/site/trust.ts",
  "lib/utils/validation.ts",
];

const COPY_MESSAGE =
  "User-facing copy on these pages is read from the locale dictionary. Add it to lib/i18n/messages and read it from there.";

const WORD = "[A-Za-z]{2}";
const TEXT_ATTRIBUTE =
  "JSXAttribute[name.name=/^(?:alt|title|label|placeholder|aria-label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder)$/]";
const CHILD = ":matches(JSXElement, JSXFragment) > JSXExpressionContainer";

/** A literal shown as it is in `container`: the expression itself, a branch of a ternary, or the
 *  right of `&&`, never a comparison or a call argument. */
function shownLiterals(container) {
  const positions = [
    "",
    " > ConditionalExpression > .consequent",
    " > ConditionalExpression > .alternate",
    " > LogicalExpression > .right",
  ];
  return positions.flatMap((position) => {
    const at = position ? `${container}${position}` : `${container} > *`;
    return [
      `${at}:matches(Literal[value=/${WORD}/])`,
      `${at}:matches(TemplateLiteral) > TemplateElement[value.raw=/${WORD}/]`,
    ];
  });
}

// Prose: three words in a row. Class lists, inline styles, import paths, directives and error
// messages are not shown to a reader.
const PROSE = "[A-Za-z]+ [A-Za-z]+ [A-Za-z]+";
const NOT_SHOWN =
  ":not(JSXAttribute[name.name=/[cC]lassName$/] *, JSXAttribute[name.name=style] *, CallExpression[callee.name=/^(?:cn|clsx|cva)$/] *, ImportDeclaration *, ExportNamedDeclaration > Literal, ExportAllDeclaration > Literal, NewExpression[callee.name=/Error$/] *, ExpressionStatement[directive] > Literal)";

const hardCodedCopy = [
  `JSXText[value=/^(?!\\s*XLM\\s*$)[\\s\\S]*${WORD}/]`,
  ...shownLiterals(`${TEXT_ATTRIBUTE} > JSXExpressionContainer`),
  `${TEXT_ATTRIBUTE} > Literal[value=/${WORD}/]`,
  ...shownLiterals(CHILD),
  `CallExpression[callee.name="pageMetadata"] Property[key.name=/^(?:title|description)$/] > :matches(Literal, TemplateLiteral)`,
  `Literal[value=/${PROSE}/]${NOT_SHOWN}`,
  `TemplateElement[value.raw=/${PROSE}/]${NOT_SHOWN}`,
].map((selector) => ({ selector, message: COPY_MESSAGE }));

const marketingSyntax = [
  ...dimWhiteText,
  ...marketingTextFloor,
  ...rawStyling,
  ...goldAction,
  ...goldFill,
];

// The web parses, verifies and signs what the API built, and never builds a transaction itself.
const NOT_BUILT_HERE =
  "apps/web never builds a transaction: the API builds it, and the web parses, verifies and signs it (TransactionBuilder.fromXDR is fine).";
const STELLAR_SDK = "/^@stellar\\/stellar-(?:sdk|base)(?:\\/|$)/";

const txConstruction = [
  "NewExpression[callee.name='TransactionBuilder']",
  "MemberExpression[object.name='TransactionBuilder'][property.name=/^(?:buildFeeBumpTransaction|cloneFrom)$/]",
  "ImportSpecifier[imported.name='TransactionBuilder'][local.name!='TransactionBuilder']",
  `ImportDeclaration[source.value=${STELLAR_SDK}] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)`,
  `ImportExpression[source.value=${STELLAR_SDK}]`,
].map((selector) => ({ selector, message: NOT_BUILT_HERE }));

const envelopeConstruction = [
  "NewExpression[callee.object.name='xdr'][callee.property.name=/^(?:Transaction|TransactionV0|TransactionV1Envelope|TransactionV0Envelope|FeeBumpTransaction|FeeBumpTransactionEnvelope|Operation)$/]",
  "MemberExpression[object.object.name='xdr'][object.property.name='TransactionEnvelope'][property.name=/^envelopeType/]",
  "MemberExpression[object.object.name='xdr'][object.property.name='OperationBody']:not([property.name='fromXDR'])",
].map((selector) => ({ selector, message: NOT_BUILT_HERE }));

const noTxBuilding = [...txConstruction, ...envelopeConstruction];

const operationBuilders = {
  group: ["@stellar/stellar-sdk", "@stellar/stellar-sdk/*"],
  importNames: ["Operation", "Account", "MuxedAccount", "Contract", "SorobanDataBuilder"],
  allowTypeImports: true,
  message: NOT_BUILT_HERE,
};

// The wallet kit's code loads only through lib/wallet-kit/loader.ts, once a wallet is restored or
// connected. A static import would put it back in a page's initial JavaScript.
const walletKitImports = {
  regex: "^@creit-tech/stellar-wallets-kit(?!/types$)(?:/.*)?$",
  allowTypeImports: true,
  message:
    "Load the wallet kit through lib/wallet-kit/loader.ts. Wallet ids are in lib/wallet-kit/wallet-ids.ts.",
};

// Pollar's code loads only through components/api-keys/pollar-loader.ts, once the visitor chooses
// the Google, GitHub or email sign-in or Pollar kept a session to restore.
const POLLAR_SIGN_IN = "components/api-keys/PollarSignIn.tsx";
const POLLAR_LOADER =
  "Load the Google, GitHub and email sign-in through components/api-keys/pollar-loader.ts.";
const pollarImports = [
  { regex: "^@pollar/", allowTypeImports: true, message: POLLAR_LOADER },
  { regex: "(?:^|/)PollarSignIn(?:\\.tsx?)?$", allowTypeImports: true, message: POLLAR_LOADER },
];

const restrictedImports = (...patterns) => ({
  "@typescript-eslint/no-restricted-imports": ["error", { patterns }],
});

/** The module list is the one file the lazy loader imports the kit's modules through. */
const WALLET_KIT_MODULES = "lib/wallet-kit/modules.ts";

// Web code may import only its own source and packages/*. The one exception is the registry data
// the API owns and validates, which the web bundles through `@registry/*` as an offline floor.
const appZones = {
  "import/no-restricted-paths": [
    "error",
    {
      basePath: import.meta.dirname,
      zones: [
        {
          target: "./",
          from: "../api",
          except: [
            "./src/config/exchange-registry.json",
            "./src/config/exchange-registry.sig.json",
            "./src/config/contract-registry.json",
          ],
          message:
            "apps/web must not import apps/api source. Reach the backend through @lumenwipe/sdk; only the two registry JSON files and the exchange registry's signature file are shared.",
        },
        {
          target: "./",
          from: "../playground",
          message:
            "apps/web must not import apps/playground. It is isolated on purpose - its custodial demo-account code must never reach production.",
        },
      ],
    },
  ],
};

const NOT_SHIPPED = ["tests/**", "scripts/**"];

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "public/a/**"] },
  ...coreWebVitals,
  prettier,
  { files: ["**/*.{ts,tsx}"], rules: { "@typescript-eslint/no-explicit-any": "error" } },
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
      ...appZones,
    },
  },
  {
    ignores: NOT_SHIPPED,
    rules: { "no-restricted-syntax": ["error", ...noTxBuilding] },
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: [...NOT_SHIPPED, WALLET_KIT_MODULES, POLLAR_SIGN_IN],
    rules: restrictedImports(operationBuilders, walletKitImports, ...pollarImports),
  },
  {
    files: [WALLET_KIT_MODULES],
    rules: restrictedImports(operationBuilders, ...pollarImports),
  },
  { files: [POLLAR_SIGN_IN], rules: restrictedImports(operationBuilders, walletKitImports) },
  // Re-wraps the transaction body the user reviewed with the cosigners' signatures: signing only.
  {
    files: ["lib/cosign/merge.ts"],
    rules: { "no-restricted-syntax": ["error", ...txConstruction] },
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: ["components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noTxBuilding,
        ...dimWhiteText,
        ...rawStyling,
        ...goldAction,
      ],
    },
  },
  {
    files: MARKETING,
    rules: { "no-restricted-syntax": ["error", ...noTxBuilding, ...marketingSyntax] },
  },
  {
    files: DICTIONARY_COPY.filter((file) => !file.startsWith("lib/")),
    rules: {
      "no-restricted-syntax": ["error", ...noTxBuilding, ...marketingSyntax, ...hardCodedCopy],
    },
  },
  {
    files: DICTIONARY_COPY.filter((file) => file.startsWith("lib/")),
    rules: { "no-restricted-syntax": ["error", ...noTxBuilding, ...hardCodedCopy] },
  },
  {
    files: ["components/ui/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...noTxBuilding, ...dimWhiteText, ...goldAction] },
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
