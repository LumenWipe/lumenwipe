import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PAGE = join(ROOT, "docs/reference/supported.mdx");

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
  entries: RegistryEntry[];
}

interface ExchangeRegistry {
  lastVerified: string;
  validUntil: string;
  entries: { name: string; address: string; requiresMemo: boolean; memoType?: string }[];
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
  Freighter: "Freighter",
  xBull: "xBull",
  Albedo: "Albedo",
  Rabet: "Rabet",
  Hana: "Hana",
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

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
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
      const status =
        live === entries.length
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
    "apps/web/lib/wallet-kit/modules.ts",
    /process\.env\.(NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID)/,
    "the WalletConnect variable"
  );
  if (!/new WalletConnectModule/.test(source)) throw new Error("WalletConnect module not found");
  rows.push([
    "WalletConnect, which is also how LOBSTR connects",
    `Enabled when \`${envVar}\` is set on the deployment`,
    "Both, set by the app's network",
  ]);
  return table(["Wallet", "When enabled", "Network"], rows);
}

function destinationsBlock(): string {
  const registry = readJson<ExchangeRegistry>("apps/api/src/config/exchange-registry.json");
  const names = [...new Set(registry.entries.map((e) => e.name))].sort();
  const memoTypes = [...new Set(registry.entries.map((e) => e.memoType ?? "none"))].sort();
  const allMemo = registry.entries.every((e) => e.requiresMemo);
  return [
    `The exchange registry lists ${names.length} exchanges across ${registry.entries.length} deposit addresses: ${names.join(", ")}.`,
    `${allMemo ? "Every" : "Some"} listed address requires a memo (memo types in the registry: ${memoTypes.join(", ")}). Last verified ${registry.lastVerified}, valid until ${registry.validUntil}.`,
  ].join(" ");
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
  const headers = read("apps/api/src/auth/rate-limiter.ts");
  if (!/RateLimit-\$\{name\}/.test(headers) || !/Retry-After/.test(headers)) {
    throw new Error("Rate limit headers changed in rate-limiter.ts");
  }
  return table(
    ["Limit", "Value", "Where it is enforced"],
    [
      ["Operations per transaction", ops, "`OP_BATCH_LIMIT` in `apps/api/src/config/constants.ts`"],
      [
        "Addresses per batch plan request",
        batch,
        "`BATCH_PLAN_MAX_ADDRESSES` in `apps/api/src/lib/close-api/batch-plan.ts`",
      ],
      [
        "JSON request body",
        body.replace("kb", " KB"),
        "`JSON_BODY_LIMIT` in `apps/api/src/configure-app.ts`",
      ],
      [
        "Default request rate",
        `${limit} requests per ${Number(ttl) / 1000} seconds, per API key`,
        "`THROTTLE_LIMIT` and `THROTTLE_TTL` defaults in `apps/api/src/app.module.ts`, overridable per deployment, and per key for self-serve keys",
      ],
    ]
  );
}

const BLOCKS: Record<string, () => string> = {
  protocols: protocolsBlock,
  wallets: walletsBlock,
  destinations: destinationsBlock,
  tokens: tokensBlock,
  limits: limitsBlock,
};

export function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " ").replace(/-{3,}/g, "---"))
    .join("\n");
}

export function render(page: string): string {
  let out = page;
  for (const [name, build] of Object.entries(BLOCKS)) {
    const pattern = new RegExp(
      `(\\{/\\* generated:${name}:start \\*/\\})[\\s\\S]*?(\\{/\\* generated:${name}:end \\*/\\})`
    );
    if (!pattern.test(out)) throw new Error(`Missing generated:${name} markers in supported.mdx`);
    out = out.replace(
      pattern,
      (_m, start: string, end: string) => `${start}\n\n${build()}\n\n${end}`
    );
  }
  return out;
}

if (import.meta.main) {
  const current = readFileSync(PAGE, "utf8");
  const next = render(current);
  if (process.argv.includes("--write")) {
    writeFileSync(PAGE, next);
  } else if (normalize(next) !== normalize(current)) {
    console.error(
      "docs/reference/supported.mdx is out of date. Run: bun scripts/supported-matrix.ts --write"
    );
    process.exit(1);
  }
}
