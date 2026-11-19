import { Address, authorizeEntry, xdr } from "@stellar/stellar-sdk";
import type { ContractChallenge } from "./client";
import { WalletSignInError } from "./wallet-sign-in";

type Entry = xdr.SorobanAuthorizationEntry;

function addressOf(entry: Entry): string | null {
  const c = entry.credentials;
  const credentials =
    c.type === "sorobanCredentialsAddress"
      ? c.address
      : c.type === "sorobanCredentialsAddressV2"
        ? c.addressV2
        : null;
  return credentials ? Address.fromScAddress(credentials.address).toString() : null;
}

function entriesOf(challenge: ContractChallenge): Entry[] {
  return xdr.decodeArray(xdr.SorobanAuthorizationEntry, challenge.authorizationEntries, "base64");
}

/** The challenge's entry for `account`, the one its signer signs, as base64 XDR. */
export function accountEntryXdr(challenge: ContractChallenge, account: string): string {
  const entry = entriesOf(challenge).find((e) => addressOf(e) === account);
  if (!entry) throw new WalletSignInError("bad_signature");
  return entry.toXdr("base64");
}

function decodeSigned(signed: string): Entry[] {
  const value = signed.trim();
  try {
    return [xdr.SorobanAuthorizationEntry.fromXdr(value, "base64")];
  } catch {
    try {
      return xdr.decodeArray(xdr.SorobanAuthorizationEntry, value, "base64", { maxLength: 2 });
    } catch {
      return [];
    }
  }
}

/**
 * The challenge's entries with the account's own replaced by the signed one, for the session
 * call. `signed` is the signed entry alone or the whole list. A signed entry for another account,
 * or one whose authorized call is not the challenge's, is refused here before it costs a round
 * trip; the API checks everything again.
 */
export function withSignedEntry(
  challenge: ContractChallenge,
  account: string,
  signed: string
): string {
  const entries = entriesOf(challenge);
  const original = entries.find((e) => addressOf(e) === account);
  const replacement = decodeSigned(signed).find((e) => addressOf(e) === account);
  if (!original || !replacement || !replacement.rootInvocation.equals(original.rootInvocation)) {
    throw new WalletSignInError("bad_signature");
  }
  return xdr.encodeArray(
    xdr.SorobanAuthorizationEntry,
    entries.map((e) => (e === original ? replacement : e)),
    "base64"
  );
}

/** The part of the wallet kit that signs an authorization entry's payload. */
export interface AuthEntrySigner {
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string }
  ): Promise<{ signedAuthEntry: string; signerAddress?: string }>;
}

function bytesFromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/**
 * Signs the account's entry through a wallet kit module: the wallet signs the entry's payload with
 * its key, and the signature is written in the standard account form. This works only for a
 * contract account whose own logic accepts that key's signature; any other refuses at the API.
 */
export async function signWithWallet(
  wallet: AuthEntrySigner,
  challenge: ContractChallenge,
  account: string
): Promise<string> {
  const entry = entriesOf(challenge).find((e) => addressOf(e) === account);
  if (!entry) throw new WalletSignInError("bad_signature");
  const signed = await authorizeEntry(
    entry,
    async (preimage) => {
      const { signedAuthEntry, signerAddress } = await wallet.signAuthEntry(
        preimage.toXdr("base64"),
        { networkPassphrase: challenge.networkPassphrase, address: account }
      );
      if (!signerAddress) throw new WalletSignInError("bad_signature");
      return { signature: bytesFromBase64(signedAuthEntry), publicKey: signerAddress };
    },
    challenge.validUntilLedger,
    challenge.networkPassphrase
  );
  return withSignedEntry(challenge, account, signed.toXdr("base64"));
}
