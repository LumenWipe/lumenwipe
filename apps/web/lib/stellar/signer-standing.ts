import type { AccountSigner } from "@/types/account";

/**
 * Whether a key can sign for the account, read from the account's signer list. A key listed with
 * weight 0 adds nothing to any threshold, so it cannot sign either.
 */
export type SignerStanding =
  { kind: "signer"; weight: number } | { kind: "zero-weight" } | { kind: "not-signer" };

export function signerStanding(key: string, signers: readonly AccountSigner[]): SignerStanding {
  const listed = signers.find((s) => s.key === key);
  if (!listed) return { kind: "not-signer" };
  return listed.weight > 0 ? { kind: "signer", weight: listed.weight } : { kind: "zero-weight" };
}

/** The standing as the signing screen states it. */
export function signerStandingText(standing: SignerStanding): string {
  switch (standing.kind) {
    case "signer":
      return `Signer on this account, weight ${standing.weight}`;
    case "zero-weight":
      return "Not a signer on this account: its weight is 0";
    case "not-signer":
      return "Not a signer on this account";
  }
}
