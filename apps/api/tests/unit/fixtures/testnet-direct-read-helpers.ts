/**
 * Builds fake `getLedgerEntries` results with real XDR types (not plain-object stand-ins), so the
 * unit tests in testnet-direct-read.test.ts exercise the same `scValToNative` decode path real
 * chain data goes through, not a shortcut that would pass even if the decode logic were wrong.
 *
 * Struct values (Positions, a FxDAO Vault) are encoded as `ScVal::Map` keyed by sorted field-name
 * symbols - the documented soroban-sdk `#[contracttype]` encoding for named-field structs used as
 * a value (as opposed to a storage *key*, which this fixture set doesn't need to fabricate: real
 * lookups always go through the production key builders in testnet-direct-read.ts).
 */
import { Address, Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { getRpcServer } from "@/lib/stellar/rpc";

type RpcServer = ReturnType<typeof getRpcServer>;
type LedgerEntry = { key: xdr.LedgerKey; val: xdr.LedgerEntryData };

export function contractInstanceEntry(
  contractAddress: string,
  wasmHashHex: string,
  /** Instance storage, as (key, value) ScVal pairs - what `#[contracttype]` instance keys hold. */
  storage: Array<[xdr.ScVal, xdr.ScVal]> = []
): LedgerEntry {
  const contract = new Contract(contractAddress);
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHashHex, "hex")),
    storage:
      storage.length === 0 ? null : storage.map(([key, val]) => new xdr.ScMapEntry({ key, val })),
  });
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contractAddress).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(instance),
    })
  );
  return { key: contract.getFootprint(), val };
}

export function contractDataEntry(
  contractAddress: string,
  key: xdr.ScVal,
  value: xdr.ScVal
): LedgerEntry {
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractAddress).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(contractAddress).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
      val: value,
    })
  );
  return { key: ledgerKey, val };
}

export const i128Val = (amount: bigint): xdr.ScVal => nativeToScVal(amount, { type: "i128" });

export function u32MapVal(entries: Array<[number, bigint]>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvU32(k), val: i128Val(v) }))
  );
}

/** The sorted-symbol-key ScMap encoding soroban-sdk uses for a named-field struct value. */
export function structVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((k) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: fields[k]! }))
  );
}

export const addressListVal = (addresses: string[]): xdr.ScVal =>
  xdr.ScVal.scvVec(addresses.map((a) => new Address(a).toScVal()));

export function mockRpc(entries: LedgerEntry[]): RpcServer {
  const getLedgerEntries = async (...keys: xdr.LedgerKey[]) => {
    const wanted = new Set(keys.map((k) => k.toXDR("base64")));
    return {
      entries: entries.filter((e) => wanted.has(e.key.toXDR("base64"))),
      latestLedger: 1,
    };
  };
  return { getLedgerEntries } as unknown as RpcServer;
}
