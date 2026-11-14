import { Address, Contract, xdr, type rpc } from "@stellar/stellar-sdk";
import { contractDataEntry, instanceOfEntry } from "@/lib/stellar/contract-data";

/** The one RPC read a contract-code check needs, so callers and tests can pass a stub. */
export type LedgerEntriesReader = Pick<rpc.Server, "getLedgerEntries">;

/** Reads a set of ledger entries, keyed by each key's base64 XDR. Callers pass their own batched,
 *  rate-limited reader so a resolution costs one more call of the same kind, not a new path. */
export type LedgerBatchReader = (
  keys: xdr.LedgerKey[]
) => Promise<Map<string, xdr.LedgerEntryData>>;

/** What an instance says its code is, before an external reference has been followed. */
export type CodeRef =
  { kind: "wasm"; wasmHash: string } | { kind: "external-ref"; owner: string; tag: string };

/**
 * The code a contract runs right now. A CAP-85 external reference names an owner contract and a
 * tag instead of a hash; the owner can repoint the tag at any time without touching the instance,
 * so the owner and tag are part of the identity and the hash is re-read on every resolution.
 */
export type CodeIdentity =
  | { kind: "wasm"; wasmHash: string }
  | { kind: "external-ref"; owner: string; tag: string; wasmHash: string };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * The executable of a contract instance as a code reference. Null for a Stellar Asset Contract
 * (no code of its own), for an external reference whose owner is not a contract (it cannot hold
 * the tag entry) or whose tag is not valid UTF-8, and for any executable this reader does not know.
 */
export function codeRefOf(instance: xdr.ScContractInstance): CodeRef | null {
  const executable = instance.executable;
  if (executable.type === "contractExecutableWasm") {
    return { kind: "wasm", wasmHash: hex(executable.wasmHash.toBytes()) };
  }
  if (executable.type !== "contractExecutableExternalRef") return null;
  const ref = executable.externalRef;
  if (ref.executableOwner.type !== "scAddressTypeContract") return null;
  let tag: string;
  try {
    tag = ref.tag.toStringStrict();
  } catch {
    return null;
  }
  return {
    kind: "external-ref",
    owner: Address.fromScAddress(ref.executableOwner).toString(),
    tag,
  };
}

/** The owner's persistent entry that holds the Wasm hash a tag names. */
export function externalRefTagKey(owner: string, tag: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(owner).toScAddress(),
      key: xdr.ScVal.scvExecutableTag(tag),
      durability: xdr.ContractDataDurability.persistent,
    })
  );
}

function tagEntryHash(data: xdr.LedgerEntryData | undefined): string | null {
  if (!data || data.type !== "contractData") return null;
  const val = contractDataEntry(data).val;
  if (val.type !== "scvBytes") return null;
  const bytes = val.bytes.toBytes();
  return bytes.length === 32 ? hex(bytes) : null;
}

/**
 * Follows every external reference to the hash its tag names, in one batched read of the
 * deduplicated owner/tag entries. An entry the ledger does not return (never written, or evicted
 * to the archive) or that does not hold a 32-byte hash leaves that reference unresolved (null),
 * the same "no code" reading an instance the ledger does not return gets. Nothing is cached.
 */
export async function resolveCodeRefs(
  read: LedgerBatchReader,
  refs: ReadonlyArray<CodeRef | null>
): Promise<Array<CodeIdentity | null>> {
  const keys = new Map<string, xdr.LedgerKey>();
  for (const ref of refs) {
    if (ref?.kind !== "external-ref") continue;
    const key = externalRefTagKey(ref.owner, ref.tag);
    keys.set(key.toXdr("base64"), key);
  }
  const tags =
    keys.size === 0 ? new Map<string, xdr.LedgerEntryData>() : await read([...keys.values()]);
  return refs.map((ref) => {
    if (ref === null || ref.kind === "wasm") return ref;
    const wasmHash = tagEntryHash(tags.get(externalRefTagKey(ref.owner, ref.tag).toXdr("base64")));
    return wasmHash === null ? null : { ...ref, wasmHash };
  });
}

/** One `getLedgerEntries` call as a batch reader. */
export function batchReaderOf(rpc: LedgerEntriesReader): LedgerBatchReader {
  return async (keys) => {
    const res = await rpc.getLedgerEntries(...keys);
    const out = new Map<string, xdr.LedgerEntryData>();
    for (const entry of res.entries ?? []) out.set(entry.key.toXdr("base64"), entry.val);
    return out;
  };
}

/**
 * Reads the code a contract is running right now, straight from its instance entry on the ledger,
 * following an external reference to its owner's tag entry. Null when the contract does not
 * exist, is not Wasm-backed (a Stellar Asset Contract has no code of its own), or names code that
 * cannot be resolved. Shared by position detection, the exit runner and the conversion round,
 * which all must check the live code against the registry before decoding or building anything.
 */
export async function readLiveCodeIdentity(
  rpc: LedgerEntriesReader,
  contractAddress: string
): Promise<CodeIdentity | null> {
  const contract = new Contract(contractAddress);
  const res = await rpc.getLedgerEntries(contract.getFootprint());
  const entry = res.entries?.[0];
  if (!entry) return null;
  const data = entry.val;
  if (data.type !== "contractData" || data.contractData.val.type !== "scvContractInstance") {
    throw new Error("the contract instance entry is malformed");
  }
  const [identity] = await resolveCodeRefs(batchReaderOf(rpc), [codeRefOf(instanceOfEntry(data))]);
  return identity ?? null;
}
