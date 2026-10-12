import type { xdr } from "@stellar/stellar-sdk";

export function contractDataEntry(data: xdr.LedgerEntryData): xdr.ContractDataEntry {
  if (data.type !== "contractData") throw new Error("the ledger entry is not contract data");
  return data.contractData;
}

export function contractDataKey(key: xdr.LedgerKey): xdr.LedgerKeyContractData {
  if (key.type !== "contractData") throw new Error("the ledger key is not contract data");
  return key.contractData;
}

export function contractInstance(val: xdr.ScVal): xdr.ScContractInstance {
  if (val.type !== "scvContractInstance") throw new Error("the value is not a contract instance");
  return val.instance;
}

export function instanceOfEntry(data: xdr.LedgerEntryData): xdr.ScContractInstance {
  return contractInstance(contractDataEntry(data).val);
}
