import { StrKey } from "@stellar/stellar-sdk";

const ADDRESS_LENGTH = 56;

export function isValidGAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/** Why `address` is not a usable account address, or null when `isValidGAddress` accepts it. Never
 *  quotes the input: what lands in an address field by mistake can be a secret key. */
export function addressErrorMessage(address: string): string | null {
  if (isValidGAddress(address)) return null;
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

export function isValidMemo(memo: string, type: "text" | "id" | "hash"): boolean {
  if (type === "text") {
    // Stellar limits memo_text to 28 UTF-8 bytes (not 28 JS characters).
    // A single emoji is 4 bytes; CJK characters are 3 bytes each.
    const bytes = new TextEncoder().encode(memo).length;
    return bytes > 0 && bytes <= 28;
  }
  if (type === "id") return /^\d+$/.test(memo) && BigInt(memo) <= BigInt("18446744073709551615");
  return memo.length > 0;
}
