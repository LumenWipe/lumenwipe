import type {
  AquariusLpPosition,
  AquariusPoolType,
  DefiPosition,
  DefiPositionsResult,
  Network,
  SoroswapLpPosition,
} from "@lumenwipe/types";
import { Logger } from "@nestjs/common";
import { Address, Contract, scValToNative, xdr } from "@stellar/stellar-sdk";
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
 * Best effort and presentation-free: a contract that cannot be read leaves its position as it
 * came, and the anchor stays fail-closed for it. Nothing here decides an amount or a call.
 */

export interface CompletePositionsDeps {
  rpc: LedgerEntriesReader;
  resolveWasmHash(network: Network, wasmHash: string): ContractResolution;
}

/** No more contracts than this are read per analysis; the rest stay as reported. */
export const MAX_COMPLETION_READS = 50;

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

const asAddress = (val: xdr.ScVal | undefined): string | null =>
  val && val.switch() === xdr.ScValType.scvAddress()
    ? Address.fromScAddress(val.address()).toString()
    : null;

function addressList(val: xdr.ScVal | undefined): string[] | null {
  if (!val || val.switch() !== xdr.ScValType.scvVec()) return null;
  const out: string[] = [];
  for (const item of val.vec() ?? []) {
    const address = asAddress(item);
    if (address === null) return null;
    out.push(address);
  }
  return out;
}

const POOL_TYPES: ReadonlySet<string> = new Set<AquariusPoolType>([
  "constant_product",
  "stable",
  "concentrated",
]);

function aquariusFields(
  instance: Instance,
  network: Network,
  deps: CompletePositionsDeps
): Pick<AquariusLpPosition, "tokens" | "shareToken" | "poolType"> {
  const storage = instance.storage;
  const tokens = storage.has('["Tokens"]')
    ? addressList(storage.get('["Tokens"]'))
    : (() => {
        const a = asAddress(storage.get('["TokenA"]'));
        const b = asAddress(storage.get('["TokenB"]'));
        return a && b ? [a, b] : null;
      })();
  const shareToken = asAddress(storage.get('["TokenShare"]'));
  const resolved = instance.wasmHash ? deps.resolveWasmHash(network, instance.wasmHash) : null;
  const poolType =
    resolved?.status === "known" && POOL_TYPES.has(resolved.version)
      ? (resolved.version as AquariusPoolType)
      : undefined;
  return {
    ...(tokens ? { tokens } : {}),
    ...(shareToken ? { shareToken } : {}),
    ...(poolType ? { poolType } : {}),
  };
}

function soroswapFields(instance: Instance): Pick<SoroswapLpPosition, "tokens"> {
  const token0 = asAddress(instance.storage.get("0"));
  const token1 = asAddress(instance.storage.get("1"));
  return token0 && token1 ? { tokens: [token0, token1] } : {};
}

function incomplete(position: DefiPosition): boolean {
  if (position.protocol === "aquarius" && position.positionType === "lp") {
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
  const contracts = [
    ...new Set(result.positions.filter(incomplete).map((p) => p.contractAddress)),
  ].slice(0, MAX_COMPLETION_READS);
  if (contracts.length === 0) return result;

  const instances = new Map<string, Instance>();
  try {
    const keys = contracts.map((c) => new Contract(c).getFootprint());
    const response = await deps.rpc.getLedgerEntries(...keys);
    for (const entry of response.entries ?? []) {
      const contract = Address.fromScAddress(entry.key.contractData().contract()).toString();
      instances.set(contract, parseInstance(entry.val));
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
        return { ...position, ...soroswapFields(instance) };
      }
    } catch {
      // A malformed instance leaves the position as reported; the anchor refuses it later.
    }
    return position;
  });
  return { ...result, positions };
}
