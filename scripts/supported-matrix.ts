import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface RegistryEntry {
  network: string;
  protocol: string;
  kind: string;
  version?: string;
  verifiedLive: boolean;
}

interface Registry {
  lastVerified: string;
  validUntil: string;
  noExitVersions?: Record<string, string[]>;
  entries: RegistryEntry[];
}

export interface ExchangeRegistry {
  lastVerified: string;
  validUntil: string;
  entries: {
    name: string;
    address: string;
    requiresMemo: boolean;
    memoType?: string;
    network?: string;
  }[];
}

interface TokenLists {
  lastVerified: string;
  mainnet: { code: string }[];
  testnet: { code: string }[];
}

interface ProtocolFacts {
  name: string;
  position: string;
  exit: string;
  limits: string;
}

const PROTOCOLS: Record<string, ProtocolFacts> = {
  blend: {
    name: "Blend",
    position: "Supply, borrow, and backstop positions",
    exit: "Repaid and withdrawn, backstop through queued withdrawal",
    limits: "A debt the spendable balance cannot cover blocks with the exact shortfall",
  },
  aquarius: {
    name: "Aquarius",
    position: "AMM liquidity and AQUA rewards",
    exit: "Withdrawn and claimed",
    limits: "A pool whose code version is not in the registry is flagged for manual review",
  },
  soroswap: {
    name: "Soroswap",
    position: "AMM liquidity",
    exit: "Liquidity removed through the router",
    limits: "An unknown contract version is flagged for manual review",
  },
  phoenix: {
    name: "Phoenix",
    position: "AMM liquidity, with optional staking",
    exit: "Each stake unbonded first, then liquidity withdrawn on a later round",
    limits: "Unbonding and withdrawal are separate transactions",
  },
  fxdao: {
    name: "FxDAO",
    position: "Collateralized debt vaults",
    exit: "Debt repaid in full, collateral returned by the protocol",
    limits: "The debt must be repaid from the account's own balance of the stablecoin",
  },
  xbull: {
    name: "xBull",
    position: "None (conversion quote source for Soroban tokens)",
    exit: "A conversion to XLM through xBull's router, raced against Soroswap",
    limits: "Mainnet only, and only when the operator has enabled it",
  },
};

const WALLETS: Record<string, string> = {
  Freighter: "Varial (formerly Freighter)",
  xBull: "xBull",
  Albedo: "Albedo",
  Rabet: "Rabet",
  Hana: "Hana",
  Ledger: "Ledger, over USB in a browser with WebUSB (Chrome, Edge)",
};

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function constant(path: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(read(path));
  if (!match?.[1]) throw new Error(`Could not read ${what} from ${path}`);
  return match[1];
}

/** Free text made safe for a Markdown table cell: backslashes first, so none can swallow a pipe's escape. */
export function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

const NETWORK_LABEL: Record<string, string> = { mainnet: "Mainnet", testnet: "Testnet" };

function protocolsBlock(): string {
  const registry = readJson<Registry>("apps/api/src/config/contract-registry.json");
  const rows: string[][] = [];
  const known = new Set(Object.keys(PROTOCOLS));
  for (const entry of registry.entries) {
    if (!known.has(entry.protocol)) {
      throw new Error(`Registry protocol "${entry.protocol}" has no row in PROTOCOLS`);
    }
  }
  for (const [key, facts] of Object.entries(PROTOCOLS)) {
    for (const network of ["mainnet", "testnet"]) {
      const entries = registry.entries.filter((e) => e.protocol === key && e.network === network);
      if (entries.length === 0) continue;
      const live = entries.filter((e) => e.verifiedLive).length;
      const noExit = registry.noExitVersions?.[key] ?? [];
      const exitless = entries.every((e) => e.version !== undefined && noExit.includes(e.version));
      const status = exitless
        ? "Registered and verified live, but the deployed code has no exit entry point: no exit is built"
        : live === entries.length
          ? `Registered, ${live} of ${entries.length} entries verified live`
          : live === 0
            ? "Registered, not verified live: no exit is built"
            : `Registered, ${live} of ${entries.length} entries verified live`;
      const kinds = [...new Set(entries.map((e) => e.kind))].join(", ");
      rows.push([
        facts.name,
        facts.position,
        facts.exit,
        NETWORK_LABEL[network]!,
        `${status} (${kinds})`,
        facts.limits,
      ]);
    }
  }
  return [
    table(
      ["Protocol", "Position type", "Exit action", "Network", "Registry status", "Known limits"],
      rows
    ),
    "",
    `Generated from \`contract-registry.json\`. Registry last verified ${registry.lastVerified}, valid until ${registry.validUntil}.`,
  ].join("\n");
}

function walletsBlock(): string {
  const source = read("apps/web/lib/wallet-kit/modules.ts");
  const body = /export function vettedDefaultModules[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  const classes = [...body.matchAll(/new (\w+)Module\(\)/g)].map((m) => m[1]!);
  if (classes.length === 0) throw new Error("No wallet modules found in modules.ts");
  const rows = classes.map((cls) => {
    const name = WALLETS[cls];
    if (!name) throw new Error(`Wallet module "${cls}" has no row in WALLETS`);
    return [name, "Always enabled", "Both, set by the app's network"];
  });
  const envVar = constant(
    "apps/web/lib/wallet-kit/wallet-connect-config.ts",
    /process\.env\.(NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID)/,
    "the WalletConnect variable"
  );
  if (!/new WalletConnectModule/.test(source)) throw new Error("WalletConnect module not found");
  rows.push([
    "WalletConnect, which is also how LOBSTR connects",
    `Enabled when \`${envVar}\` is set on the deployment; a production deployment does not build without it`,
    "Both, set by the app's network",
  ]);
  return table(["Wallet", "When enabled", "Network"], rows);
}

/** The public count leaves out testnet-only entries: they are not exchanges a user can close to. */
export function destinationsText(registry: ExchangeRegistry): string {
  const entries = registry.entries.filter((e) => e.network === undefined);
  const names = [...new Set(entries.map((e) => e.name))].sort();
  const memoTypes = [...new Set(entries.map((e) => e.memoType ?? "none"))].sort();
  const allMemo = entries.every((e) => e.requiresMemo);
  return [
    `The exchange registry lists ${names.length} exchanges across ${entries.length} deposit addresses: ${names.join(", ")}.`,
    `${allMemo ? "Every" : "Some"} listed address requires a memo (memo types in the registry: ${memoTypes.join(", ")}). Last verified ${registry.lastVerified}, valid until ${registry.validUntil}.`,
  ].join(" ");
}

function destinationsBlock(): string {
  return destinationsText(readJson<ExchangeRegistry>("apps/api/src/config/exchange-registry.json"));
}

function tokensBlock(): string {
  const lists = readJson<TokenLists>("apps/api/src/config/soroban-token-lists.json");
  const codes = (list: { code: string }[]): string =>
    list.length === 0 ? "none" : list.map((t) => t.code).join(", ");
  return [
    table(
      ["Network", "Soroban tokens on the bundled list", "Last verified"],
      [
        ["Mainnet", codes(lists.mainnet), lists.lastVerified],
        ["Testnet", codes(lists.testnet), lists.lastVerified],
      ]
    ),
    "",
    "The list is a discovery aid. Generated from `soroban-token-lists.json`.",
  ].join("\n");
}

function limitsBlock(): string {
  const ops = constant(
    "apps/api/src/config/constants.ts",
    /export const OP_BATCH_LIMIT = (\d+);/,
    "OP_BATCH_LIMIT"
  );
  const batch = constant(
    "apps/api/src/lib/close-api/batch-plan.ts",
    /export const BATCH_PLAN_MAX_ADDRESSES = (\d+);/,
    "BATCH_PLAN_MAX_ADDRESSES"
  );
  const hashes = constant(
    "apps/api/src/lib/close-api/delivered-amount.ts",
    /export const DELIVERED_MAX_HASHES = (\d+);/,
    "DELIVERED_MAX_HASHES"
  );
  const body = constant(
    "apps/api/src/configure-app.ts",
    /export const JSON_BODY_LIMIT = "(\w+)";/,
    "JSON_BODY_LIMIT"
  );
  const ttl = constant(
    "apps/api/src/app.module.ts",
    /positiveIntEnv\("THROTTLE_TTL", ([\d_]+)\)/,
    "THROTTLE_TTL"
  ).replace(/_/g, "");
  const limit = constant(
    "apps/api/src/app.module.ts",
    /positiveIntEnv\("THROTTLE_LIMIT", (\d+)\)/,
    "THROTTLE_LIMIT"
  );
  const keys = constant(
    "apps/api/src/integrator/integrator.controller.ts",
    /const MAX_ACTIVE_KEYS_PER_OWNER = (\d+);/,
    "MAX_ACTIVE_KEYS_PER_OWNER"
  );
  const label = constant(
    "apps/api/src/integrator/key-options.ts",
    /export const MAX_LABEL_LENGTH = (\d+);/,
    "MAX_LABEL_LENGTH"
  );
  const challenge = constant(
    "apps/api/src/integrator/wallet-auth.ts",
    /const CHALLENGE_TTL_SECONDS = (\d+);/,
    "CHALLENGE_TTL_SECONDS"
  );
  const session = constant(
    "apps/api/src/integrator/wallet-auth.ts",
    /const SESSION_TTL_SECONDS = (\d+);/,
    "SESSION_TTL_SECONDS"
  );
  const headers = read("apps/api/src/auth/rate-limiter.ts");
  if (!/RateLimit-\$\{name\}/.test(headers) || !/Retry-After/.test(headers)) {
    throw new Error("Rate limit headers changed in rate-limiter.ts");
  }
  return table(
    ["Limit", "Value", "Where it is enforced"],
    [
      [
        "Default request rate",
        `${limit} requests per ${Number(ttl) / 1000} seconds, per API key`,
        "`THROTTLE_LIMIT` and `THROTTLE_TTL` defaults in `apps/api/src/app.module.ts`, overridable per deployment, and per key for self-serve keys",
      ],
      [
        "Active keys per wallet",
        keys,
        "`MAX_ACTIVE_KEYS_PER_OWNER` in `apps/api/src/integrator/integrator.controller.ts`",
      ],
      [
        "Key label",
        `1 to ${label} characters`,
        "`MAX_LABEL_LENGTH` in `apps/api/src/integrator/key-options.ts`",
      ],
      [
        "Sign-in challenge lifetime",
        `${Number(challenge) / 60} minutes`,
        "`CHALLENGE_TTL_SECONDS` in `apps/api/src/integrator/wallet-auth.ts`",
      ],
      [
        "Key management session lifetime",
        `${Number(session) / 60} minutes`,
        "`SESSION_TTL_SECONDS` in `apps/api/src/integrator/wallet-auth.ts`",
      ],
      ["Operations per transaction", ops, "`OP_BATCH_LIMIT` in `apps/api/src/config/constants.ts`"],
      [
        "Addresses per batch plan request",
        batch,
        "`BATCH_PLAN_MAX_ADDRESSES` in `apps/api/src/lib/close-api/batch-plan.ts`",
      ],
      [
        "Hashes per `close/delivered` request",
        hashes,
        "`DELIVERED_MAX_HASHES` in `apps/api/src/lib/close-api/delivered-amount.ts`",
      ],
      [
        "JSON request body",
        body.replace("kb", " KB"),
        "`JSON_BODY_LIMIT` in `apps/api/src/configure-app.ts`",
      ],
    ]
  );
}

interface OpenApi {
  paths: Record<string, Record<string, { summary?: string }>>;
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

/** One row per operation in the published OpenAPI document, in its order. */
export function endpointsTable(openapi: OpenApi): string {
  const rows: string[][] = [];
  for (const [path, operations] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!HTTP_METHODS.includes(method)) continue;
      if (!operation.summary) throw new Error(`${method.toUpperCase()} ${path} has no summary`);
      rows.push([`\`${method.toUpperCase()} ${path}\``, operation.summary]);
    }
  }
  if (rows.length === 0) throw new Error("The OpenAPI document lists no operations");
  return table(["Endpoint", "Purpose"], rows);
}

function endpointsBlock(): string {
  return endpointsTable(readJson<OpenApi>("docs/api-reference/openapi.json"));
}

export type EnvApp = "api" | "web" | "playground";

export interface EnvironmentFacts {
  required: "Yes" | "No" | "Production" | "Tests only";
  secret: boolean;
  default: string;
  purpose: string;
}

const NONE = "None";
const ON = "`true`";

function optional(purpose: string, secret = false, value = NONE): EnvironmentFacts {
  return { required: "No", secret, default: value, purpose };
}

function header(target: string, url: string, part: "NAME" | "VALUE"): EnvironmentFacts {
  return part === "NAME"
    ? optional(`Name of the auth header sent to the ${url} ${target}`)
    : optional(`Value of the auth header sent to the ${url} ${target}`, true);
}

function killSwitch(path: string): EnvironmentFacts {
  return optional(
    `Kill switch for ${path}; any value other than \`true\` or \`false\` refuses the boot`,
    false,
    ON
  );
}

/**
 * Every variable the `.env.example` files list, classified by a person: whether it must be set,
 * whether its value is a secret, and what it falls back to. A variable added to an example
 * without an entry here fails the generator, so nothing reaches the reference unclassified.
 */
export const ENVIRONMENT: Record<EnvApp, Record<string, EnvironmentFacts>> = {
  api: {
    API_KEYS: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose:
        "Accepted API keys as comma-separated `label=key` pairs; the API refuses to boot without it",
    },
    LOG_HASH_KEY: optional(
      "Key for the short hash that matches log lines about one address",
      true,
      "A random key per process"
    ),
    THROTTLE_LIMIT: optional("Requests per window, per API key", false, "`120`"),
    THROTTLE_TTL: optional("Rate limit window in milliseconds", false, "`60000`"),
    ADMIN_API_TOKEN: optional(
      "Operator token for `/admin/api-keys/*`; needs `FIRESTORE_PROJECT_ID`",
      true
    ),
    FIRESTORE_PROJECT_ID: optional(
      "GCP project holding the self-serve key store",
      false,
      "An in-memory store"
    ),
    FIRESTORE_DATABASE_ID: optional("Firestore database the stores use", false, "`(default)`"),
    INTEGRATOR_AUTH_SECRET: optional(
      "Signs the wallet sign-in challenge and session tokens, at least 32 characters",
      true
    ),
    INTEGRATOR_WEB_AUTH_SIGNING_SEED: optional(
      "Secret seed (S...) of the server account that signs contract-account sign-in challenges; the account must exist on each network. Without it, contract-account sign-in answers 503",
      true
    ),
    INTEGRATOR_WEB_AUTH_CONTRACT_TESTNET: optional(
      "Testnet instance (C...) of the SEP-45 web authentication contract, running the attested build; mainnet uses SDF's deployment. The repository variable of the same name holds the same value, and the nightly `web-auth-ttl` job extends that contract's TTL",
      false,
      "Contract-account sign-in is off on testnet"
    ),
    PORT: optional("Port the API listens on", false, "`3001`"),
    STELLAR_RPC_TESTNET: optional(
      "Testnet Stellar RPC, one URL or a comma-separated failover list; secret because a provider URL can carry its key",
      true,
      "`https://soroban-testnet.stellar.org`"
    ),
    STELLAR_RPC_MAINNET: {
      required: "Production",
      secret: true,
      default: "`https://mainnet.sorobanrpc.com`",
      purpose:
        "Mainnet Stellar RPC, one URL or a list; the default is for development, a production boot refuses to start without it. Secret: a URL can carry its key",
    },
    STELLAR_RPC_HEADER_NAME_TESTNET: header("Stellar RPC", "first testnet", "NAME"),
    STELLAR_RPC_HEADER_VALUE_TESTNET: header("Stellar RPC", "first testnet", "VALUE"),
    STELLAR_RPC_HEADER_NAME_MAINNET: header("Stellar RPC", "first mainnet", "NAME"),
    STELLAR_RPC_HEADER_VALUE_MAINNET: header("Stellar RPC", "first mainnet", "VALUE"),
    STELLAR_RPC_HEADER_NAME_MAINNET_2: header("Stellar RPC", "second mainnet", "NAME"),
    STELLAR_RPC_HEADER_VALUE_MAINNET_2: header("Stellar RPC", "second mainnet", "VALUE"),
    STELLAR_RPC_HEADER_NAME_MAINNET_3: header("Stellar RPC", "third mainnet", "NAME"),
    STELLAR_RPC_HEADER_VALUE_MAINNET_3: header("Stellar RPC", "third mainnet", "VALUE"),
    PATH_ROUTING_API_TESTNET: optional(
      "Testnet Horizon-compatible endpoint for account state and conversion paths; account reads fail without it. Secret because a provider URL can carry its key",
      true
    ),
    PATH_ROUTING_API_MAINNET: {
      required: "Production",
      secret: true,
      default: NONE,
      purpose:
        "Mainnet Horizon-compatible endpoint for account state and conversion paths; a production boot refuses to start without it. Secret: a URL can carry its key",
    },
    PATH_ROUTING_API_HEADER_NAME_MAINNET: header(
      "Horizon-compatible endpoint",
      "first mainnet",
      "NAME"
    ),
    PATH_ROUTING_API_HEADER_VALUE_MAINNET: header(
      "Horizon-compatible endpoint",
      "first mainnet",
      "VALUE"
    ),
    PATH_ROUTING_API_HEADER_NAME_MAINNET_2: header(
      "Horizon-compatible endpoint",
      "second mainnet",
      "NAME"
    ),
    PATH_ROUTING_API_HEADER_VALUE_MAINNET_2: header(
      "Horizon-compatible endpoint",
      "second mainnet",
      "VALUE"
    ),
    OCTOPOS_API_URL_MAINNET: optional(
      "OctoPos DeFi position detection; unset means a classic-only close",
      false
    ),
    OCTOPOS_API_KEY: optional("Raises OctoPos to its authenticated rate tier", true),
    STELLARINDEX_API_KEY: optional(
      "StellarIndex mainnet key; turns its account data on for token and allowance discovery",
      true
    ),
    STELLARINDEX_API_URL_MAINNET: optional(
      "StellarIndex API on mainnet",
      false,
      "`https://api.stellarindex.io/v1`"
    ),
    STELLARINDEX_API_URL_TESTNET: optional(
      "StellarIndex API on testnet",
      false,
      "`https://api.testnet.stellarindex.io/v1`"
    ),
    MEDIATOR_PUBLIC_TESTNET: optional(
      "Public key of the testnet mediator; checked against its secret",
      false
    ),
    MEDIATOR_PUBLIC_MAINNET: optional(
      "Public key of the mainnet mediator; checked against its secret",
      false
    ),
    MEDIATOR_SECRET_TESTNET: optional(
      "Testnet mediator signing key; without it testnet exchange closes are unavailable",
      true
    ),
    MEDIATOR_SECRET_MAINNET: optional(
      "Mainnet mediator signing key; without it mainnet exchange closes are unavailable",
      true
    ),
    FEE_ACCOUNT_SECRET_TESTNET: optional(
      "Testnet fee-bump sponsor key; without it testnet sponsored closes are unavailable",
      true
    ),
    FEE_ACCOUNT_SECRET_MAINNET: optional(
      "Mainnet fee-bump sponsor key; without it mainnet sponsored closes are unavailable",
      true
    ),
    SOROSWAP_API_URL: optional("Soroswap API base URL", false, "The Soroswap SDK's default"),
    SOROSWAP_API_KEY: optional(
      "Soroswap API key (`sk_...`); without it Soroban tokens are never swapped",
      true
    ),
    SOROBAN_CONVERSION_ENABLED: optional(
      "`true` enables Soroban token conversion to XLM",
      false,
      "`false`"
    ),
    XBULL_SWAP_API_URL: optional("xBull swap API base URL", false, "`https://swap-api.xbull.io`"),
    XBULL_CONVERSION_ENABLED: optional(
      "`true` adds xBull's router as a mainnet quote source",
      false,
      "`false`"
    ),
    FEE_SPONSORSHIP_ENABLED: killSwitch("sponsored-fee closes"),
    MEDIATOR_FORWARD_ENABLED: killSwitch("the mediator forward of exchange closes"),
    AQUARIUS_EXIT_ENABLED: killSwitch("Aquarius exits"),
    BLEND_EXIT_ENABLED: killSwitch("Blend exits"),
    FXDAO_EXIT_ENABLED: killSwitch("FxDAO exits"),
    PHOENIX_EXIT_ENABLED: killSwitch("Phoenix exits"),
    SOROSWAP_EXIT_ENABLED: killSwitch("Soroswap exits"),
    PHOENIX_TESTNET_TOKEN_ADMIN_SECRET: {
      required: "Tests only",
      secret: true,
      default: NONE,
      purpose:
        "Admin of the project's testnet Phoenix test token and pool, for the funded integration tests and the pool's deployment script",
    },
    FXDAO_TESTNET_ORACLE_ADMIN_SECRET: {
      required: "Tests only",
      secret: true,
      default: NONE,
      purpose: "Admin of the project's testnet FxDAO oracle, for the funded integration tests",
    },
  },
  web: {
    LUMENWIPE_API_URL: {
      required: "Yes",
      secret: false,
      default: NONE,
      purpose: "Base URL of the API the `/api/**` proxy forwards to",
    },
    LUMENWIPE_API_KEY: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose: "One of the API's `API_KEYS`, injected server-side by the proxy",
    },
    UPSTASH_REDIS_REST_URL: {
      required: "Production",
      secret: false,
      default: NONE,
      purpose: "Upstash Redis for the proxy rate limit; unset disables it",
    },
    UPSTASH_REDIS_REST_TOKEN: {
      required: "Production",
      secret: true,
      default: NONE,
      purpose: "Token for that Upstash Redis",
    },
    KV_REST_API_URL: optional(
      "Name the Vercel Upstash integration injects; read when `UPSTASH_REDIS_REST_URL` is unset"
    ),
    KV_REST_API_TOKEN: optional(
      "Name the Vercel Upstash integration injects; read when `UPSTASH_REDIS_REST_TOKEN` is unset",
      true
    ),
    RATE_LIMIT_HASH_KEY: {
      required: "Production",
      secret: true,
      default: NONE,
      purpose:
        "Key for the hash of the client IP in the proxy rate-limit counters, at least 32 characters; unset on a deployment makes the limiter unavailable",
    },
    STATUS_SOURCE_URL: optional(
      "https URL of the status summary the site banner reads through `/api/status`; unset, no page shows the banner. Prerendered pages read it at build time"
    ),
    NEXT_PUBLIC_APP_URL: {
      required: "Production",
      secret: false,
      default: NONE,
      purpose: "Public site origin; a production build fails without it",
    },
    NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY: optional(
      "Pollar publishable key for the `/api-keys` Google, GitHub and email sign-in"
    ),
    NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID: {
      required: "Production",
      secret: false,
      default: NONE,
      purpose: "WalletConnect project ID; without it the WalletConnect option is unavailable",
    },
    NEXT_PUBLIC_UMAMI_WEBSITE_ID: optional(
      "Umami Cloud website ID; analytics on the marketing pages only, off when unset"
    ),
  },
  playground: {
    PLAYGROUND_ENCRYPTION_KEY: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose: "64 hex characters that encrypt session records at rest",
    },
    PLAYGROUND_ISSUER_SECRET_TESTNET: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose: "Testnet issuer of the demo asset",
    },
    PLAYGROUND_MM_SECRET_TESTNET: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose: "Testnet market maker that funds each demo",
    },
    PLAYGROUND_TOKEN_ADMIN_SECRET_TESTNET: optional(
      "Testnet admin of the playground token: mints it and signs `bun run token:deploy`; without it the Soroban token scenario is unavailable",
      true
    ),
    PLAYGROUND_DISABLED_SCENARIOS: optional("Comma-separated scenario ids to switch off"),
    CRON_SECRET: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose: "Bearer secret of the daily reaper; without it no session is created",
    },
    UPSTASH_REDIS_REST_URL: {
      required: "Production",
      secret: false,
      default: NONE,
      purpose: "The playground's Upstash Redis REST URL",
    },
    UPSTASH_REDIS_REST_TOKEN: {
      required: "Production",
      secret: true,
      default: NONE,
      purpose: "Token for that Upstash Redis",
    },
    RATE_LIMIT_HASH_KEY: {
      required: "Production",
      secret: true,
      default: NONE,
      purpose:
        "Key for the hash of the client IP in the rate-limit counters, at least 32 characters, never the web's; unset on a deployment leaves the routes unlimited",
    },
    PLAYGROUND_DEV_FILE_STORE: optional(
      "`1` keeps sessions in a private local file; ignored by production builds and on Vercel"
    ),
    LUMENWIPE_API_URL: {
      required: "Yes",
      secret: false,
      default: NONE,
      purpose: "Base URL of the API for the close step",
    },
    LUMENWIPE_API_KEY: {
      required: "Yes",
      secret: true,
      default: NONE,
      purpose: "The API key under the API's `playground` label",
    },
    PLAYGROUND_EXPECTED_FEE_ACCOUNT_TESTNET: optional(
      "Public key of the API's testnet fee sponsor; without it the sponsored-fee scenario is unavailable"
    ),
    PLAYGROUND_EXPECTED_MEDIATOR_TESTNET: optional(
      "Public key of the API's testnet mediator; without it the exchange-close scenario is unavailable"
    ),
  },
};

const ENV_APPS: EnvApp[] = ["api", "web", "playground"];
const ENV_ENTRY = /^([A-Z][A-Z0-9_]*)=/;
const COMMENTED_ENV_ENTRY = /^#\s?([A-Z][A-Z0-9_]*)=\S*\s*$/;

/** The variables a template lists, set or commented out, in file order. */
export function templateVariables(template: string): string[] {
  const names: string[] = [];
  for (const line of template.split("\n")) {
    const name = (ENV_ENTRY.exec(line) ?? COMMENTED_ENV_ENTRY.exec(line))?.[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The environment reference, or an error naming every variable the record and templates disagree on. */
export function environmentTable(
  templates: Record<EnvApp, string>,
  facts: Record<EnvApp, Record<string, EnvironmentFacts>> = ENVIRONMENT
): string {
  const problems: string[] = [];
  const rows: string[][] = [];
  for (const app of ENV_APPS) {
    const listed = templateVariables(templates[app]);
    for (const name of listed) {
      const fact = facts[app][name];
      if (!fact) {
        problems.push(`${name} is in apps/${app}/.env.example but has no entry in ENVIRONMENT`);
        continue;
      }
      if (fact.secret && name.startsWith("NEXT_PUBLIC_")) {
        problems.push(
          `${name} is marked secret, but NEXT_PUBLIC_ values ship in the browser bundle`
        );
      }
      rows.push([
        `\`${name}\``,
        app,
        fact.required,
        fact.secret ? "Secret" : "Public",
        fact.default,
        fact.purpose,
      ]);
    }
    for (const name of Object.keys(facts[app])) {
      if (!listed.includes(name)) {
        problems.push(`${name} has an entry in ENVIRONMENT but is not in apps/${app}/.env.example`);
      }
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return table(["Variable", "App", "Required", "Secret or public", "Default", "Purpose"], rows);
}

function environmentBlock(): string {
  const templates = Object.fromEntries(
    ENV_APPS.map((app) => [app, read(`apps/${app}/.env.example`)])
  ) as Record<EnvApp, string>;
  return environmentTable(templates);
}

interface AnchoredBlock {
  /** The sentence the generated table follows, which a reader sees in place of a marker. */
  after: string;
  build: () => string;
}

type Block = (() => string) | AnchoredBlock;

export const ENDPOINTS_ANCHOR =
  "The REST surface, generated from `docs/api-reference/openapi.json` by `bun scripts/supported-matrix.ts --write`:";

const PAGES: Record<string, Record<string, Block>> = {
  "docs/reference/supported.mdx": {
    protocols: protocolsBlock,
    wallets: walletsBlock,
    destinations: destinationsBlock,
    tokens: tokensBlock,
  },
  "docs/integrators/limits.mdx": { limits: limitsBlock },
  "docs/reference/environment.mdx": { environment: environmentBlock },
  "docs/architecture.md": { endpoints: { after: ENDPOINTS_ANCHOR, build: endpointsBlock } },
};

export function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " ").replace(/-{3,}/g, "---"))
    .join("\n");
}

/**
 * Replaces the table that follows `block.after` (a Markdown page GitHub also renders, where a
 * comment marker would show as text). A page without the sentence throws.
 */
function renderAfter(page: string, path: string, block: AnchoredBlock): string {
  const at = page.indexOf(block.after);
  if (at === -1) throw new Error(`Missing the sentence the generated table follows in ${path}`);
  const start = at + block.after.length;
  const lines = page.slice(start).split("\n");
  let end = 1;
  while (end < lines.length && lines[end]!.trim() === "") end++;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  const rest = lines.slice(end).join("\n");
  return `${page.slice(0, start)}\n\n${block.build()}\n${rest.startsWith("\n") ? "" : "\n"}${rest}`;
}

export function render(page: string, path: string): string {
  const blocks = PAGES[path];
  if (!blocks) throw new Error(`${path} has no generated blocks`);
  let out = page;
  for (const [name, block] of Object.entries(blocks)) {
    if (typeof block !== "function") {
      out = renderAfter(out, path, block);
      continue;
    }
    const build = block;
    const pattern = new RegExp(
      `(\\{/\\* generated:${name}:start \\*/\\})[\\s\\S]*?(\\{/\\* generated:${name}:end \\*/\\})`
    );
    if (!pattern.test(out)) throw new Error(`Missing generated:${name} markers in ${path}`);
    out = out.replace(
      pattern,
      (_m, start: string, end: string) => `${start}\n\n${build()}\n\n${end}`
    );
  }
  return out;
}

if (import.meta.main) {
  const stale: string[] = [];
  for (const path of Object.keys(PAGES)) {
    const current = read(path);
    let next: string;
    try {
      next = render(current, path);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
    if (process.argv.includes("--write")) {
      writeFileSync(join(ROOT, path), next);
    } else if (normalize(next) !== normalize(current)) {
      stale.push(path);
    }
  }
  if (stale.length > 0) {
    console.error(`${stale.join(", ")} out of date. Run: bun scripts/supported-matrix.ts --write`);
    process.exit(1);
  }
}
