import { Keypair, StrKey } from "@stellar/stellar-sdk";

// Real strkeys: a made-up 56 or 69 character string fails the checksum and proves nothing.
export const G_ADDRESS = Keypair.random().publicKey();
export const C_ADDRESS = StrKey.encodeContract(new Uint8Array(32).fill(7));
export const W_ADDRESS = StrKey.encodeMuxedContract(new Uint8Array(40).fill(9));

/** The same address with its last character changed, so the checksum no longer matches. */
export function tampered(address: string): string {
  return address.slice(0, -1) + (address.endsWith("A") ? "B" : "A");
}
