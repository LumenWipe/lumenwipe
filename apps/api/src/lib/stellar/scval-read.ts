import { Address, xdr, scValToNative } from "@stellar/stellar-sdk";

export const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export function addressOf(val: xdr.ScVal): string | null {
  try {
    return val.switch() === xdr.ScValType.scvAddress() ? Address.fromScVal(val).toString() : null;
  } catch {
    return null;
  }
}

export function bigOf(val: xdr.ScVal): bigint | null {
  try {
    const native: unknown = scValToNative(val);
    if (typeof native === "bigint") return native;
    if (typeof native === "number" && Number.isSafeInteger(native)) return BigInt(native);
    return null;
  } catch {
    return null;
  }
}

/** No Stellar account may appear anywhere in a swap's arguments but as the account itself. */
export function collectAccounts(val: xdr.ScVal, account: string): void {
  switch (val.switch()) {
    case xdr.ScValType.scvAddress(): {
      const addr = val.address();
      if (addr.switch() === xdr.ScAddressType.scAddressTypeAccount()) {
        if (Address.fromScAddress(addr).toString() !== account) {
          throw new Error("the swap names an account other than the one being closed");
        }
      } else if (addr.switch() !== xdr.ScAddressType.scAddressTypeContract()) {
        throw new Error("the swap names an address form that cannot be verified");
      }
      return;
    }
    case xdr.ScValType.scvVec():
      for (const v of val.vec() ?? []) collectAccounts(v, account);
      return;
    case xdr.ScValType.scvMap():
      for (const entry of val.map() ?? []) {
        collectAccounts(entry.key(), account);
        collectAccounts(entry.val(), account);
      }
      return;
    default:
      return;
  }
}
