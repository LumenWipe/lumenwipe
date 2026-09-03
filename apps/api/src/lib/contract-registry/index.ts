import rawRegistry from "@/config/contract-registry.json";
import type { DefiProtocol, Network } from "@lumenwipe/types";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * The versioned wasmHash contract registry architecture.md §9 describes, shared by two consumers:
 *
 * - The testnet DeFi-detection fallback (#148) asks "which contracts do I probe for a position on
 *   this network?" - `entriesForNetwork` / `entriesForProtocol` - and then confirms each one is
 *   still running the code it was verified against.
 * - Every exit adapter asks "which interface does this contract speak?" - `resolveWasmHash` -
 *   before it builds anything. An unknown hash resolves to `{ status: "unknown" }`, and the
 *   caller's only safe move is to flag the position for manual review and build nothing (§9.9).
 *
 * Resolution is network-scoped: an entry records the network its hash was verified on, and a hash
 * resolved from any other network is unknown there. Content-addressing makes the interface the
 * same everywhere, but "someone verified this version on this network" is what the registry
 * actually records, so the lookup enforces it rather than leaving it as reviewer folklore.
 *
 * The data lives in src/config/contract-registry.json and is community-updated by pull request
 * (§14), which is why loading validates every field instead of trusting the file: a typo'd hash,
 * protocol name, or checksum-invalid address in a merged PR must fail the build's tests, never
 * resolve wrongly at runtime. A protocol upgrade is a new entry here plus an adapter change, not
 * a rewrite (§18).
 *
 * Not served over HTTP, unlike the exchange registry: the web holds no transaction-building or
 * position-detection logic (CLAUDE.md's trust boundary), so nothing client-side ever needs a
 * wasmHash. This stays an internal API module.
 */

// Record<...> tables rather than bare arrays so the type system enforces exhaustiveness in both
// directions: a member added to the shared union without a row here fails to compile, and so
// does a typo'd key.
const PROTOCOLS: Record<DefiProtocol, true> = {
  blend: true,
  aquarius: true,
  soroswap: true,
  phoenix: true,
  fxdao: true,
};
const NETWORKS: Record<Network, true> = { mainnet: true, testnet: true };

export type ContractKind = "pool" | "pair" | "backstop" | "vault" | "factory" | "router";
const KINDS: Record<ContractKind, true> = {
  pool: true,
  pair: true,
  backstop: true,
  vault: true,
  factory: true,
  router: true,
};

const ALL_PROTOCOLS = Object.keys(PROTOCOLS) as DefiProtocol[];
const ALL_NETWORKS = Object.keys(NETWORKS) as Network[];
const ALL_KINDS = Object.keys(KINDS) as ContractKind[];

export interface ContractRegistryEntry {
  network: Network;
  protocol: DefiProtocol;
  kind: ContractKind;
  /** Contract address (C...) of the deployed instance. */
  address: string;
  /** 64 lowercase hex chars - the SHA-256 of the deployed code. Null only for an entry documented
   *  by the protocol's own docs but not currently resolvable on-chain (`verifiedLive: false`) -
   *  never fabricated to fill the field. */
  wasmHash: string | null;
  /** The protocol's own version name for this code, e.g. "v2". */
  version: string;
  label: string;
  /** Whether the address resolved on-chain when `lastVerified` was set. */
  verifiedLive: boolean;
  /** The exact command or explorer link the hash was verified with, so a reviewer can re-run it. */
  verifiedBy?: string;
}

export interface ContractRegistry {
  version: string;
  /** The date a human last checked every entry against live RPC and the protocols' own docs. */
  lastVerified: string;
  /** After this date the data is treated as unusable, not merely old. */
  validUntil: string;
  source: string;
  entries: ContractRegistryEntry[];
}

/**
 * The result an exit adapter must branch on. Modeled as a union rather than `entry | null` so
 * that "unknown" is a value that has to be handled, not an absence that can be optional-chained
 * past on the way to building a wrong exit. Several deployed instances can share one code hash
 * (every pool a factory deploys does), so a known result names the code version, not one address.
 */
export type ContractResolution =
  | {
      status: "known";
      protocol: DefiProtocol;
      kind: ContractKind;
      version: string;
      wasmHash: string;
    }
  | { status: "unknown"; wasmHash: string };

const WASM_HASH_SHAPE = /^[0-9a-f]{64}$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/** Community-edited fields stay human-sized; a URL, a CLI command, or a label fits, a blob does not. */
const MAX_FIELD_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function fail(path: string, problem: string): never {
  throw new Error(`contract-registry.json: ${path} ${problem}`);
}

function requireKeys(value: Record<string, unknown>, path: string, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, "is not a recognized field");
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  if (value.length > MAX_FIELD_LENGTH) {
    fail(path, `must be at most ${MAX_FIELD_LENGTH} characters`);
  }
  return value;
}

function requireDate(value: unknown, path: string): string {
  const date = requireString(value, path);
  if (!ISO_DATE_SHAPE.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    fail(path, "must be a YYYY-MM-DD date");
  }
  return date;
}

function validateEntry(raw: unknown, path: string): ContractRegistryEntry {
  if (!isRecord(raw)) fail(path, "must be an object");
  requireKeys(raw, path, [
    "network",
    "protocol",
    "kind",
    "address",
    "wasmHash",
    "version",
    "label",
    "verifiedLive",
    "verifiedBy",
  ]);
  if (!isOneOf(raw.network, ALL_NETWORKS)) {
    fail(`${path}.network`, `must be one of: ${ALL_NETWORKS.join(", ")}`);
  }
  if (!isOneOf(raw.protocol, ALL_PROTOCOLS)) {
    fail(`${path}.protocol`, `must be one of: ${ALL_PROTOCOLS.join(", ")}`);
  }
  if (!isOneOf(raw.kind, ALL_KINDS)) {
    fail(`${path}.kind`, `must be one of: ${ALL_KINDS.join(", ")}`);
  }
  const address = requireString(raw.address, `${path}.address`);
  // Full StrKey decode, not a shape regex: the trailing CRC16 checksum exists precisely so a
  // single transposed character is caught here at merge time, not at probe time on live testnet.
  if (!StrKey.isValidContract(address)) {
    fail(`${path}.address`, "must be a valid C... contract address (StrKey checksum)");
  }
  if (typeof raw.verifiedLive !== "boolean") fail(`${path}.verifiedLive`, "must be a boolean");

  let wasmHash: string | null;
  if (raw.wasmHash === null) {
    // A null hash is the honest record of "documented but not resolvable right now". An entry
    // that did resolve live has a hash by definition, so null there is a missing field, not a fact.
    if (raw.verifiedLive) fail(`${path}.wasmHash`, "cannot be null when verifiedLive is true");
    wasmHash = null;
  } else {
    wasmHash = requireString(raw.wasmHash, `${path}.wasmHash`);
    if (!WASM_HASH_SHAPE.test(wasmHash)) {
      fail(`${path}.wasmHash`, "must be 64 lowercase hex characters, or null");
    }
  }

  const entry: ContractRegistryEntry = {
    network: raw.network,
    protocol: raw.protocol,
    kind: raw.kind,
    address,
    wasmHash,
    version: requireString(raw.version, `${path}.version`),
    label: requireString(raw.label, `${path}.label`),
    verifiedLive: raw.verifiedLive,
  };
  if (raw.verifiedBy !== undefined) {
    entry.verifiedBy = requireString(raw.verifiedBy, `${path}.verifiedBy`);
  }
  return entry;
}

function deepFreeze(registry: ContractRegistry): ContractRegistry {
  for (const entry of registry.entries) Object.freeze(entry);
  Object.freeze(registry.entries);
  return Object.freeze(registry);
}

/**
 * Pure validator, exported so the unit suite can both reject malformed shapes and - the part
 * that matters for community PRs - assert that the shipped JSON itself always parses. A registry
 * edit that breaks this fails CI before it can ship. The validated structure comes back deeply
 * frozen: lookups hand out these exact objects, and a consumer mutating one must throw rather
 * than silently rewrite what every later resolution in the process returns.
 */
export function validateContractRegistry(raw: unknown): ContractRegistry {
  if (!isRecord(raw)) fail("root", "must be an object");
  requireKeys(raw, "root", ["version", "lastVerified", "validUntil", "source", "entries"]);
  if (!Array.isArray(raw.entries)) fail("entries", "must be an array");

  const lastVerified = requireDate(raw.lastVerified, "lastVerified");
  const validUntil = requireDate(raw.validUntil, "validUntil");
  if (validUntil < lastVerified) fail("validUntil", "must not precede lastVerified");

  const entries = raw.entries.map((e, i) => validateEntry(e, `entries[${i}]`));

  const seenAddresses = new Set<string>();
  const versionByHash = new Map<string, ContractRegistryEntry>();
  for (const entry of entries) {
    const addressKey = `${entry.network}:${entry.address}`;
    if (seenAddresses.has(addressKey)) fail("entries", `duplicate address ${addressKey}`);
    seenAddresses.add(addressKey);

    // One hash is one protocol version. Many instances may share it (every pool a factory
    // deploys does), so duplicates are fine - contradictions are not. A genuine collision (a fork
    // shipping byte-identical code) is ambiguous by nature and needs a human decision, not a merge.
    if (entry.wasmHash === null) continue;
    const prior = versionByHash.get(entry.wasmHash);
    if (
      prior &&
      (prior.protocol !== entry.protocol ||
        prior.version !== entry.version ||
        prior.kind !== entry.kind)
    ) {
      fail("entries", `wasmHash ${entry.wasmHash} maps to conflicting protocol versions`);
    }
    versionByHash.set(entry.wasmHash, entry);
  }

  return deepFreeze({
    version: requireString(raw.version, "version"),
    lastVerified,
    validUntil,
    source: requireString(raw.source, "source"),
    entries,
  });
}

export interface ContractRegistryLookup {
  registry: ContractRegistry;
  isRegistryFresh: (now?: Date) => boolean;
  entriesForNetwork: (network: Network) => ContractRegistryEntry[];
  entriesForProtocol: (network: Network, protocol: DefiProtocol) => ContractRegistryEntry[];
  resolveWasmHash: (network: Network, wasmHash: string) => ContractResolution;
}

/**
 * Builds the lookup functions over one validated registry. The module-level exports are this
 * factory applied to the shipped JSON; tests apply it to fixtures, so every path - including a
 * known resolution - is exercised regardless of what the shipped file happens to contain.
 */
export function createContractRegistryLookup(registry: ContractRegistry): ContractRegistryLookup {
  const { entries } = registry;

  return {
    registry,

    /** Same fail-closed convention as lib/exchange-registry: compared as dates, not "days since,"
     *  so the rule lives in the data rather than in whichever consumer evaluates it. */
    isRegistryFresh(now: Date = new Date()): boolean {
      const validUntil = Date.parse(`${registry.validUntil}T23:59:59Z`);
      return Number.isFinite(validUntil) && now.getTime() <= validUntil;
    },

    entriesForNetwork(network: Network): ContractRegistryEntry[] {
      return entries.filter((e) => e.network === network);
    },

    entriesForProtocol(network: Network, protocol: DefiProtocol): ContractRegistryEntry[] {
      return entries.filter((e) => e.network === network && e.protocol === protocol);
    },

    /**
     * Resolves a contract's code hash to the protocol version it was verified as, on one network.
     * Input is whatever a live ledger read produced, so it is normalized (trimmed, lowercased)
     * rather than trusted to match the file's canonical form - and a malformed or non-string hash
     * (a SAC executable has none) resolves to "unknown" instead of throwing, because a hostile or
     * odd contract on someone's account must surface as a manual-review flag, not crash their
     * close plan. A hash never verified on the caller's network is unknown there.
     */
    resolveWasmHash(network: Network, wasmHash: string): ContractResolution {
      if (typeof wasmHash !== "string") return { status: "unknown", wasmHash: "" };
      const normalized = wasmHash.trim().toLowerCase();
      const match = entries.find((e) => e.network === network && e.wasmHash === normalized);
      if (!match || match.wasmHash === null) return { status: "unknown", wasmHash: normalized };
      return {
        status: "known",
        protocol: match.protocol,
        kind: match.kind,
        version: match.version,
        wasmHash: match.wasmHash,
      };
    },
  };
}

const shipped = createContractRegistryLookup(validateContractRegistry(rawRegistry));

/** The registry as loaded and validated, with the freshness a consumer can judge it by. */
export function servedContractRegistry(): ContractRegistry {
  return shipped.registry;
}

export function isRegistryFresh(now: Date = new Date()): boolean {
  return shipped.isRegistryFresh(now);
}

export function entriesForNetwork(network: Network): ContractRegistryEntry[] {
  return shipped.entriesForNetwork(network);
}

export function entriesForProtocol(
  network: Network,
  protocol: DefiProtocol
): ContractRegistryEntry[] {
  return shipped.entriesForProtocol(network, protocol);
}

export function resolveWasmHash(network: Network, wasmHash: string): ContractResolution {
  return shipped.resolveWasmHash(network, wasmHash);
}
