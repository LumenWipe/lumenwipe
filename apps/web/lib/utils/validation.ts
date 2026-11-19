import { StrKey } from "@stellar/stellar-sdk";
import { SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
import { ADDRESS } from "@/lib/i18n/messages/address";

const ADDRESS_LENGTH = 56;

export function isValidGAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/** Why a value is not a usable account address. */
export type AddressProblem = "secret-key" | "muxed" | "prefix" | "length" | "checksum";

export const SECRET_KEY_WARNING = ADDRESS[SITE_LOCALE].problems["secret-key"];

export const MUXED_ADDRESS_MESSAGE = ADDRESS[SITE_LOCALE].problems.muxed;

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

/** Why `address` is not a usable account address, or null when `isValidGAddress` accepts it. */
export function addressProblem(address: string): AddressProblem | null {
  if (isValidGAddress(address)) return null;
  if (looksLikeSecretKey(address)) return "secret-key";
  // Stripping the mux id ourselves would send the deposit with nothing to credit it by.
  if (isValidMuxedAddress(address)) return "muxed";
  if (!address.startsWith("G")) return "prefix";
  if (address.length !== ADDRESS_LENGTH) return "length";
  return "checksum";
}

/** The sentence for `addressProblem`, in `locale`. Never quotes the input: what lands in an
 *  address field by mistake can be a secret key. */
export function addressErrorMessage(address: string, locale: Locale = SITE_LOCALE): string | null {
  const problem = addressProblem(address);
  return problem && ADDRESS[locale].problems[problem];
}

export function isValidSecretKey(secret: string): boolean {
  try {
    return StrKey.isValidEd25519SecretSeed(secret);
  } catch {
    return false;
  }
}
