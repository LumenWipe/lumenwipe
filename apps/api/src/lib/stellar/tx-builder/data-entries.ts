import { TransactionBuilder, Operation, Account, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS, TX_TIMEOUT_SECONDS } from "@/config/constants";
import type { DataEntry } from "@lumenwipe/types";

export function dataEntryRemovalOps(entries: DataEntry[]): xdr.Operation[] {
  // Setting value to null removes the data entry.
  return entries.map((entry) => Operation.manageData({ name: entry.key, value: null }));
}

export function buildRemoveDataEntriesTx(
  sdkAccount: Account,
  entries: DataEntry[],
  network: Network
): string {
  const ops = dataEntryRemovalOps(entries);
  // Per-operation fee: TransactionBuilder multiplies this by the operation count itself, so
  // pre-multiplying here would double-count it (BASE_FEE_STROOPS * N passed in, then * N again
  // by the SDK, charging N^2 instead of N).
  const builder = new TransactionBuilder(sdkAccount, {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  }).setTimeout(TX_TIMEOUT_SECONDS);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}
