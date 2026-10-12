import { Contract, type rpc } from "@stellar/stellar-sdk";

/** The one RPC read a contract-code check needs, so callers and tests can pass a stub. */
export type LedgerEntriesReader = Pick<rpc.Server, "getLedgerEntries">;

/**
 * Reads the wasmHash a contract is running right now, straight from its instance entry on the
 * ledger. Null when the contract does not exist or is not Wasm-backed (a Stellar Asset Contract
 * has no code of its own). Shared by position detection and by the exit runner, which both must
 * check the live code against the registry before decoding or building anything against it.
 */
export async function readLiveWasmHash(
  rpc: LedgerEntriesReader,
  contractAddress: string
): Promise<string | null> {
  const contract = new Contract(contractAddress);
  const res = await rpc.getLedgerEntries(contract.getFootprint());
  const entry = res.entries?.[0];
  if (!entry) return null;
  const data = entry.val;
  if (data.type !== "contractData" || data.contractData.val.type !== "scvContractInstance") {
    throw new Error("the contract instance entry is malformed");
  }
  const executable = data.contractData.val.instance.executable;
  if (executable.type !== "contractExecutableWasm") return null;
  return Buffer.from(executable.wasmHash.toBytes()).toString("hex");
}
