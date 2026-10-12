import type { xdr } from "@stellar/stellar-sdk";

export function contractDataVal(data: xdr.LedgerEntryData): xdr.ScVal {
  if (data.type !== "contractData") throw new Error("expected a contract data entry");
  return data.contractData.val;
}
