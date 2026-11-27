import { StrKey } from "@stellar/stellar-sdk";

export function isValidGAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/** A strkey that is valid and well-formed but is not an account address LumenWipe can use. */
export type UnsupportedAddressKind = "contract" | "muxed_contract";

/**
 * Which unsupported kind `address` is, or null when it is not a valid contract (C...) or muxed
 * contract (W...) strkey. Anything that is not a valid strkey, including a garbled or non-string
 * value, is null so the caller keeps its own "invalid address" refusal.
 */
export function unsupportedAddressKind(address: unknown): UnsupportedAddressKind | null {
  // The SDK's validators return false for any string, however malformed; they take no other type.
  if (typeof address !== "string") return null;
  if (StrKey.isValidContract(address)) return "contract";
  if (StrKey.isValidMuxedContract(address)) return "muxed_contract";
  return null;
}

/** Fixed sentences: they name the kind and never quote the input, which may be a secret key. */
export const UNSUPPORTED_ADDRESS_MESSAGES: Record<UnsupportedAddressKind, string> = {
  contract:
    "This is a contract address (C...). Closing and analysing contract accounts is not supported yet. Use a Stellar account address (G...).",
  muxed_contract:
    "This is a muxed contract address (W...). Closing and analysing contract accounts is not supported yet. A muxed contract address is only valid as the destination of a Stellar Asset Contract transfer. Use a Stellar account address (G...).",
};

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
