import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "../../../lib/exchange-registry/canonical";
import {
  SIGNING_LABEL,
  signingBytes,
  type RegistrySignature,
} from "../../../lib/exchange-registry/signature";

export interface RegistryBody {
  version: string;
  lastVerified: string;
  validUntil: string;
  source: string;
  entries: unknown[];
}

export const TEST_NOW = new Date("2026-11-27T12:00:00Z");

export function registryBody(entries: unknown[], over: Partial<RegistryBody> = {}): RegistryBody {
  return {
    version: "2026-11-27",
    lastVerified: "2026-11-27",
    validUntil: "2027-02-15",
    source: "https://registry.example/directory",
    entries,
    ...over,
  };
}

export function exchangeEntry(address: string, over: Record<string, unknown> = {}) {
  return {
    address,
    name: "Newly Listed",
    domain: "newly-listed.example",
    requiresMediator: true,
    requiresMemo: true,
    memoType: "text" as const,
    ...over,
  };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function signBody(
  body: RegistryBody,
  signer: Keypair,
  meta: { sequence?: number; issuedAt?: string } = {}
): RegistryBody & { signature: RegistrySignature } {
  const sequence = meta.sequence ?? 5;
  const issuedAt = meta.issuedAt ?? "2026-11-27";
  const bytes = signingBytes(body, { sequence, issuedAt });
  if (bytes === null) throw new Error("fixture registry is not canonical");
  return {
    ...body,
    signature: {
      format: 1,
      sequence,
      issuedAt,
      signature: base64(signer.sign(Buffer.from(bytes))),
    },
  };
}

/** A signature over the same document with another label, as a replay under a different purpose
 *  would present it. */
export function signUnderLabel(
  body: RegistryBody,
  signer: Keypair,
  label: string,
  meta: { sequence: number; issuedAt: string }
): RegistrySignature {
  const text = canonicalJson({
    format: 1,
    issuedAt: meta.issuedAt,
    registry: {
      version: body.version,
      lastVerified: body.lastVerified,
      validUntil: body.validUntil,
      source: body.source,
      entries: body.entries,
    },
    sequence: meta.sequence,
  });
  const bytes = new TextEncoder().encode(label === "" ? text : `${label}\n${text}`);
  return { format: 1, ...meta, signature: base64(signer.sign(Buffer.from(bytes))) };
}

export { SIGNING_LABEL };
