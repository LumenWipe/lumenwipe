import { StrKey } from "@stellar/stellar-sdk";

export function isValidGAddress(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
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
