import { StrKey } from "@stellar/stellar-sdk";

const ADDRESS_LENGTH = 56;

export function isValidGAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

export const SECRET_KEY_WARNING =
  "That looks like a secret key. Never paste it here. LumenWipe only needs your public address (starts with G).";

export const MUXED_ADDRESS_MESSAGE =
  "This looks like a muxed address. Use the G address plus the memo your exchange shows.";

/** The shape of a secret seed, without its checksum. Shape alone is enough to refuse it, and a
 *  value that only looks like a key is never worth keeping either. */
export function looksLikeSecretKey(value: string): boolean {
  return /^S[A-Z2-7]{55}$/.test(value);
}

function isValidMuxedAddress(address: string): boolean {
  try {
    return StrKey.isValidMed25519PublicKey(address);
  } catch {
    return false;
  }
}

/** Why `address` is not a usable account address, or null when `isValidGAddress` accepts it. Never
 *  quotes the input: what lands in an address field by mistake can be a secret key. */
export function addressErrorMessage(address: string): string | null {
  if (isValidGAddress(address)) return null;
  if (looksLikeSecretKey(address)) return SECRET_KEY_WARNING;
  // Stripping the mux id ourselves would send the deposit with nothing to credit it by.
  if (isValidMuxedAddress(address)) return MUXED_ADDRESS_MESSAGE;
  if (!address.startsWith("G")) return "A Stellar account address starts with G.";
  if (address.length !== ADDRESS_LENGTH) {
    return `A Stellar account address has ${ADDRESS_LENGTH} characters.`;
  }
  return "This address has a typo: its checksum does not match. Copy it again from the source.";
}

export function isValidSecretKey(secret: string): boolean {
  try {
    return StrKey.isValidEd25519SecretSeed(secret);
  } catch {
    return false;
  }
}
