import type {
  AquariusLpPosition,
  AquariusPoolType,
  DefiPosition,
  DefiPositionsResult,
  Network,
  SoroswapLpPosition,
} from "@lumenwipe/types";
import { Logger } from "@nestjs/common";
import { Address, Contract, StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import { resolveWasmHash, type ContractResolution } from "@/lib/contract-registry";
import type { LedgerEntriesReader } from "@/lib/stellar/contract-instance";
import { getRpcServer } from "@/lib/stellar/rpc";

/**
 * Fills in what a position indexer does not carry but the exit path needs from the position
 * itself: an Aquarius pool's tokens, share token, and code type, and a Soroswap pair's tokens.
 *
 * The web anchor lets an exit name a token contract only if it is a held asset's Stellar Asset
 * Contract or one of the position's own tokens (or its share token, which a withdrawal burns
 * under the account's authority). OctoPos reports a mainnet LP position by pool and share amount
 * alone, so without this pass every mainnet withdrawal that touched a Soroban-native token or a
 * share token would fail verification with a misleading message. The testnet direct read fills
 * these fields as it sweeps; here they come from the same instance keys, one read per contract.
 *
 * The registry is the trust root here as everywhere else: a position's fields are filled only
 * from a contract whose live code the registry knows as that protocol's pool or pair. What a
 * position names becomes what the anchor admits, so an indexer entry pointing at a contract of
 * unknown code must not get to nominate token contracts; it stays as reported, and the exit for
 * it halts at the registry gate anyway.
 *
 * Best effort and presentation-free: a contract that cannot be read leaves its position as it
 * came, and the anchor stays fail-closed for it. Nothing here decides an amount or a call.
 */

export interface CompletePositionsDeps {
  rpc: LedgerEntriesReader;
  resolveWasmHash(network: Network, wasmHash: string): ContractResolution;
}

/** No more contracts than this are read per analysis; the rest stay as reported. */
export const MAX_COMPLETION_READS = 50;
/** A read that takes longer than this leaves every position as reported; the analysis goes on. */
export const COMPLETION_TIMEOUT_MS = 8_000;

const logger = new Logger("complete-positions");

interface Instance {
  wasmHash: string | null;
  storage: Map<string, xdr.ScVal>;
}

function parseInstance(val: xdr.LedgerEntryData): Instance {
  const instance = val.contractData().val().instance();
  const executable = instance.executable();
  const wasmHash =
    executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()
      ? executable.wasmHash().toString("hex")
      : null;
  const storage = new Map<string, xdr.ScVal>();
  for (const entry of instance.storage() ?? []) {
    try {
      const name: unknown = JSON.stringify(scValToNative(entry.key()));
      if (typeof name === "string") storage.set(name, entry.val());
    } catch {
      continue;
    }
  }
  return { wasmHash, storage };
}

/** A contract address, and only a contract address: a token is never an account. */
const asContract = (val: xdr.ScVal | undefined): string | null =>
  val &&
  val.switch() === xdr.ScValType.scvAddress() &&
  val.address().switch() === xdr.ScAddressType.scAddressTypeContract()
    ? Address.fromScAddress(val.address()).toString()
    : null;

/** At least two distinct token contracts, or nothing: a pool of one token is not a pool. */
function tokenList(val: xdr.ScVal | undefined): string[] | null {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const out: string[] = [];
  for (const item of val.vec() ?? []) {
    const address = asContract(item);
    if (address === null) return null;
    out.push(address);
  }
  return out.length >= 2 && new Set(out).size === out.length ? out : null;
}

const POOL_TYPES: ReadonlySet<string> = new Set<AquariusPoolType>([
  "constant_product",
  "stable",
  "concentrated",
]);

/** The registry's word on the contract's live code, or null when it has none. */
function known(
  instance: Instance,
  network: Network,
  deps: CompletePositionsDeps
): Extract<ContractResolution, { status: "known" }> | null {
  if (!instance.wasmHash) return null;
  const resolved = deps.resolveWasmHash(network, instance.wasmHash);
  return resolved.status === "known" ? resolved : null;
}

function aquariusFields(
  instance: Instance,
  network: Network,
  deps: CompletePositionsDeps
): Pick<AquariusLpPosition, "tokens" | "shareToken" | "poolType"> {
  const code = known(instance, network, deps);
  if (!code || code.protocol !== "aquarius" || code.kind !== "pool") return {};
  const storage = instance.storage;
  const tokens = storage.has('["Tokens"]')
    ? tokenList(storage.get('["Tokens"]'))
    : tokenList(
        xdr.ScVal.scvVec(
          [storage.get('["TokenA"]'), storage.get('["TokenB"]')].filter(
            (v): v is xdr.ScVal => v !== undefined
          )
        )
      );
  const shareToken = asContract(storage.get('["TokenShare"]'));
  const poolType = POOL_TYPES.has(code.version) ? (code.version as AquariusPoolType) : undefined;
  return {
    ...(tokens ? { tokens } : {}),
    ...(shareToken ? { shareToken } : {}),
    ...(poolType ? { poolType } : {}),
  };
}

function soroswapFields(
  instance: Instance,
  network: Network,
  deps: CompletePositionsDeps
): Pick<SoroswapLpPosition, "tokens"> {
  const code = known(instance, network, deps);
  if (!code || code.protocol !== "soroswap" || code.kind !== "pair") return {};
  const tokens = tokenList(
    xdr.ScVal.scvVec(
      [instance.storage.get("0"), instance.storage.get("1")].filter(
        (v): v is xdr.ScVal => v !== undefined
      )
    )
  );
  return tokens && tokens.length === 2 ? { tokens: [tokens[0]!, tokens[1]!] } : {};
}

function incomplete(position: DefiPosition): boolean {
  if (position.protocol === "aquarius" && position.positionType === "lp") {
    // A concentrated pool keeps no share token and lists no tokens the same way; once its code
    // is known there is nothing more to read (and nothing to exit, by design).
    if (position.poolType === "concentrated") return false;
    return !position.tokens || !position.shareToken || !position.poolType;
  }
  if (position.protocol === "soroswap" && position.positionType === "lp") {
    return !position.tokens;
  }
  return false;
}

export function defaultCompletePositionsDeps(network: Network): CompletePositionsDeps {
  return { rpc: getRpcServer(network), resolveWasmHash };
}

/**
 * The result with every incomplete Aquarius and Soroswap LP position completed from its
 * contract's instance where that could be read. Never throws.
 */
export async function completePositionsFromLedger(
  result: DefiPositionsResult,
  network: Network,
  deps: CompletePositionsDeps = defaultCompletePositionsDeps(network)
): Promise<DefiPositionsResult> {
  const distinct = [
    ...new Set(
      result.positions
        .filter(incomplete)
        .map((p) => p.contractAddress)
        .filter((c) => StrKey.isValidContract(c))
    ),
  ];
  const contracts = distinct.slice(0, MAX_COMPLETION_READS);
  if (contracts.length === 0) return result;
  if (distinct.length > contracts.length) {
    logger.warn(
      `${distinct.length - contracts.length} position contract(s) on ${network} left as reported: read cap reached`
    );
  }

  const instances = new Map<string, Instance>();
  try {
    const keys = contracts.map((c) => new Contract(c).getFootprint());
    const response = await Promise.race([
      deps.rpc.getLedgerEntries(...keys),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), COMPLETION_TIMEOUT_MS).unref?.()
      ),
    ]);
    for (const entry of response.entries ?? []) {
      try {
        const contract = Address.fromScAddress(entry.key.contractData().contract()).toString();
        instances.set(contract, parseInstance(entry.val));
      } catch {
        // An entry that is not a contract instance is not one we asked for.
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `could not read ${contracts.length} position contract(s) on ${network}: ${message}`
    );
    return result;
  }

  const positions = result.positions.map((position): DefiPosition => {
    if (!incomplete(position)) return position;
    const instance = instances.get(position.contractAddress);
    if (!instance) return position;
    try {
      if (position.protocol === "aquarius" && position.positionType === "lp") {
        return { ...position, ...aquariusFields(instance, network, deps) };
      }
      if (position.protocol === "soroswap" && position.positionType === "lp") {
        return { ...position, ...soroswapFields(instance, network, deps) };
      }
    } catch {
      // A malformed instance leaves the position as reported; the anchor refuses it later.
    }
    return position;
  });
  return { ...result, positions };
}
