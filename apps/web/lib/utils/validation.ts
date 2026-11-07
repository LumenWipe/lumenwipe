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

// A key only as a whole token: inside a longer base32 run, such as a muxed address, the same 56
// characters are part of something else.
const SECRET_KEY_TOKEN = /(^|[^A-Z2-7])S[A-Z2-7]{55}($|[^A-Z2-7])/;

/** Whether a secret seed appears anywhere in `value`, also once the whitespace inside it is
 *  removed, so a key copied in groups of four is found too. */
export function containsSecretKey(value: string): boolean {
  return SECRET_KEY_TOKEN.test(value) || SECRET_KEY_TOKEN.test(value.replace(/\s+/g, ""));
}

/** What an address field refuses before it reaches any state: a value that holds a secret key,
 *  and anything starting with S, since no account address does and a seed always does. */
export function couldBeSecretKey(value: string): boolean {
  return value.trim().startsWith("S") || containsSecretKey(value);
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
