/**
 * Builds `vectors/registry-signing-v1.json`, the conformance vectors for the exchange registry
 * signature: the canonical form, the signed bytes, the key check, the rollback rule and the
 * freshness rule. `generate-vectors.ts` writes it next to the close vectors and its `--check`
 * compares both.
 *
 * Every synthetic vector is signed here by a throwaway key from a fixed seed, and only the public
 * half is written, so the output is byte-for-byte stable and holds no secret. The last vector is
 * the committed registry with its committed signature, checked against the keys pinned in the
 * package: it is the one vector made with the production key, and regenerating the file after a
 * signing is how it is refreshed. A missing signature file stops the generator.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hash, Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "../../../apps/web/lib/exchange-registry/canonical";
import {
  SIGNING_LABEL,
  parseSignature,
  signingBytes,
  type RegistrySignature,
  type SignatureFailure,
} from "../../../apps/web/lib/exchange-registry/signature";
import { REGISTRY_SIGNING_KEYS } from "../../../apps/web/lib/exchange-registry/trust-roots";

export const REGISTRY_SIGNING_VECTORS_PATH = fileURLToPath(
  new URL("../vectors/registry-signing-v1.json", import.meta.url)
);
const REGISTRY_PATH = fileURLToPath(
  new URL("../../../apps/api/src/config/exchange-registry.json", import.meta.url)
);
const SIGNATURE_PATH = fileURLToPath(
  new URL("../../../apps/api/src/config/exchange-registry.sig.json", import.meta.url)
);

const NOW = "2026-11-27T12:00:00Z";
const BUNDLED_SEQUENCE = 5;

const signer = (label: string): Keypair =>
  Keypair.fromRawEd25519Seed(hash(Buffer.from(`lumenwipe registry-signing-v1 ${label}`)));
const PRIMARY = signer("primary");
const BACKUP = signer("backup");
const OUTSIDER = signer("outsider");
const KEYS = [PRIMARY.publicKey(), BACKUP.publicKey()];

type Registry = Record<string, unknown>;

const registry = (): Registry => ({
  version: "2026-11-27",
  lastVerified: "2026-11-27",
  validUntil: "2027-02-15",
  source: "https://registry.example/directory",
  entries: [
    {
      address: signer("exchange deposit address").publicKey(),
      name: "Example Exchange",
      domain: "exchange.example",
      requiresMediator: true,
      requiresMemo: true,
      memoType: "text",
    },
  ],
});

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const textBytes = (text: string): Buffer => Buffer.from(new TextEncoder().encode(text));

function envelopeFor(
  body: Registry,
  by: Keypair,
  meta: { sequence: number; issuedAt: string } = {
    sequence: BUNDLED_SEQUENCE + 1,
    issuedAt: "2026-11-27",
  }
): RegistrySignature {
  const bytes = signingBytes(body, meta);
  if (bytes === null) throw new Error("a vector registry must be canonical");
  return { format: 1, ...meta, signature: b64(by.sign(Buffer.from(bytes))) };
}

function signedUnderLabel(
  body: Registry,
  label: string,
  meta: { sequence: number; issuedAt: string }
) {
  const text = canonicalJson({
    format: 1,
    issuedAt: meta.issuedAt,
    registry: body,
    sequence: meta.sequence,
  });
  return {
    format: 1 as const,
    ...meta,
    signature: b64(PRIMARY.sign(textBytes(label === "" ? text : `${label}\n${text}`))),
  };
}

interface VectorBase {
  name: string;
  description: string;
  nowSeconds: number;
  bundledSequence: number;
  publicKeys: string[];
  registry: Registry;
  /** Absent when the document carries no signature. */
  signature?: unknown;
}

export interface RegistrySigningAccept extends VectorBase {
  verdict: "accept";
  sequence: number;
  /** The exact text that was signed, label included, for implementations to reproduce. */
  signedText?: string;
}

export interface RegistrySigningReject extends VectorBase {
  verdict: "reject";
  /** What differs from a vector that is accepted. */
  mutation: string;
  reason: SignatureFailure;
}

export type RegistrySigningVector = RegistrySigningAccept | RegistrySigningReject;

export interface RegistrySigningVectorFile {
  schema: 1;
  name: "registry-signing-v1";
  description: string;
  generator: string;
  label: string;
  vectors: RegistrySigningVector[];
}

const seconds = (iso: string): number => Date.parse(iso) / 1000;

export function buildRegistrySigningVectorFile(): RegistrySigningVectorFile {
  const vectors: RegistrySigningVector[] = [];
  const base = (name: string, description: string, over: Partial<VectorBase> = {}): VectorBase => ({
    name,
    description,
    nowSeconds: seconds(NOW),
    bundledSequence: BUNDLED_SEQUENCE,
    publicKeys: KEYS,
    registry: registry(),
    ...over,
  });
  const accept = (v: VectorBase, sequence: number, signedText?: string): void => {
    vectors.push({ verdict: "accept", ...v, sequence, ...(signedText ? { signedText } : {}) });
  };
  const reject = (v: VectorBase, mutation: string, reason: SignatureFailure): void => {
    vectors.push({ verdict: "reject", ...v, mutation, reason });
  };

  const body = registry();
  const meta = { sequence: BUNDLED_SEQUENCE + 1, issuedAt: "2026-11-27" };
  const primarySigned = envelopeFor(body, PRIMARY);
  const signedBytes = signingBytes(body, meta);
  if (signedBytes === null) throw new Error("a vector registry must be canonical");

  accept(
    base(
      "signed-by-primary-key",
      "A registry signed by the first pinned key, newer than the bundled one.",
      {
        signature: primarySigned,
      }
    ),
    meta.sequence,
    new TextDecoder().decode(signedBytes)
  );
  accept(
    base(
      "signed-by-backup-key",
      "The same registry signed by the second pinned key. Either key verifies.",
      {
        signature: envelopeFor(body, BACKUP),
      }
    ),
    meta.sequence
  );
  accept(
    base(
      "sequence-equal-to-bundled",
      "A document whose sequence equals the bundled one is the bundled document and is accepted.",
      {
        signature: envelopeFor(body, PRIMARY, {
          sequence: BUNDLED_SEQUENCE,
          issuedAt: "2026-11-27",
        }),
      }
    ),
    BUNDLED_SEQUENCE
  );
  accept(
    base(
      "last-second-of-valid-until",
      "A document is usable through the last second of validUntil.",
      {
        nowSeconds: seconds("2027-02-15T23:59:59Z"),
        signature: primarySigned,
      }
    ),
    meta.sequence
  );
  accept(
    base(
      "issued-one-day-ahead-of-the-clock",
      "A document issued within a day after the verifier's clock is accepted, so a clock a little behind does not refuse a fresh one.",
      {
        nowSeconds: seconds("2026-11-26T12:00:00Z"),
        signature: primarySigned,
      }
    ),
    meta.sequence
  );

  reject(
    base("forged-signature", "A signature of the right shape that no key made.", {
      signature: { ...primarySigned, signature: b64(Buffer.alloc(64, 7)) },
    }),
    "The signature bytes are not a signature by any pinned key.",
    "bad-signature"
  );
  reject(
    base("wrong-key", "A valid signature by a key that is not pinned.", {
      signature: envelopeFor(body, OUTSIDER),
    }),
    "Signed by a key outside publicKeys.",
    "bad-signature"
  );
  const flipped = registry();
  (flipped.entries as Registry[])[0] = {
    ...(flipped.entries as Registry[])[0],
    requiresMediator: false,
  };
  reject(
    base("tampered-entry", "An entry's mediator flag changed after signing.", {
      registry: flipped,
      signature: primarySigned,
    }),
    "entries[0].requiresMediator was changed after the signature was made.",
    "bad-signature"
  );
  reject(
    base("tampered-valid-until", "validUntil moved later after signing.", {
      registry: { ...registry(), validUntil: "2027-03-31" },
      signature: primarySigned,
    }),
    "validUntil was changed after the signature was made.",
    "bad-signature"
  );
  reject(
    base("tampered-sequence", "The sequence in the envelope was raised after signing.", {
      signature: { ...primarySigned, sequence: meta.sequence + 10 },
    }),
    "The envelope's sequence differs from the one that was signed.",
    "bad-signature"
  );
  reject(
    base("tampered-issued-at", "The issue date in the envelope was changed after signing.", {
      signature: { ...primarySigned, issuedAt: "2026-11-26" },
    }),
    "The envelope's issuedAt differs from the one that was signed.",
    "bad-signature"
  );
  reject(
    base("signature-over-another-registry", "A valid signature made over a different registry.", {
      signature: envelopeFor({ ...registry(), version: "another" }, PRIMARY),
    }),
    "The signature covers a registry with another version.",
    "bad-signature"
  );
  reject(
    base("no-domain-label", "A signature over the canonical document without the label.", {
      signature: signedUnderLabel(body, "", meta),
    }),
    "The signed bytes have no label.",
    "bad-signature"
  );
  reject(
    base("other-label", "A signature under another purpose's label.", {
      signature: signedUnderLabel(body, "lumenwipe.other.signature.v1", meta),
    }),
    "The signed bytes start with another label.",
    "bad-signature"
  );
  reject(
    base("label-version-2", "A signature under the next version's label.", {
      signature: signedUnderLabel(body, SIGNING_LABEL.replace(/v1$/, "v2"), meta),
    }),
    "The signed bytes start with the v2 label.",
    "bad-signature"
  );
  reject(
    base("missing-signature", "A registry with no signature at all."),
    "The signature field is absent.",
    "malformed"
  );
  reject(
    base("truncated-signature", "A signature one byte short.", {
      signature: {
        ...primarySigned,
        signature: b64(Buffer.from(primarySigned.signature, "base64").subarray(0, 63)),
      },
    }),
    "The signature is 63 bytes.",
    "malformed"
  );
  reject(
    base("extended-signature", "A signature one byte long.", {
      signature: {
        ...primarySigned,
        signature: b64(
          Buffer.concat([Buffer.from(primarySigned.signature, "base64"), Buffer.from([0])])
        ),
      },
    }),
    "The signature is 65 bytes.",
    "malformed"
  );
  reject(
    base("empty-signature", "An empty signature string.", {
      signature: { ...primarySigned, signature: "" },
    }),
    "The signature is empty.",
    "malformed"
  );
  const last = primarySigned.signature[85] as string;
  reject(
    base(
      "non-canonical-base64",
      "A signature whose base64 has non-zero padding bits: it decodes to the same bytes and is still refused.",
      {
        signature: {
          ...primarySigned,
          signature: `${primarySigned.signature.slice(0, 85)}${String.fromCharCode(last.charCodeAt(0) + 1)}==`,
        },
      }
    ),
    "The final base64 character carries padding bits.",
    "malformed"
  );
  reject(
    base("unknown-envelope-field", "An envelope with a field beyond the four.", {
      signature: { ...primarySigned, keyId: "primary" },
    }),
    "The envelope has an extra field.",
    "malformed"
  );
  reject(
    base(
      "stale-sequence-replay",
      "A valid, older signed document replayed to a client whose bundled registry is newer.",
      {
        bundledSequence: meta.sequence + 1,
        signature: primarySigned,
      }
    ),
    "The document's sequence is below the bundled one.",
    "stale-sequence"
  );
  reject(
    base("stale-document-past-valid-until", "A valid signed document used after its validUntil.", {
      nowSeconds: seconds("2027-02-16T00:00:00Z"),
      signature: primarySigned,
    }),
    "The clock is one second past the last moment of validUntil.",
    "expired"
  );
  reject(
    base("issued-in-the-future", "A document issued more than a day after the verifier's clock.", {
      nowSeconds: seconds("2026-11-25T23:59:59Z"),
      signature: primarySigned,
    }),
    "issuedAt is more than a day ahead of the clock.",
    "future-dated"
  );

  const committedRegistry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as Registry;
  const committed = parseSignature(JSON.parse(readFileSync(SIGNATURE_PATH, "utf8")));
  if (committed === null)
    throw new Error("The committed exchange registry signature is malformed.");
  accept(
    {
      name: "production-signed-registry",
      description:
        "The exchange registry committed in the repository with its committed signature, checked against the keys pinned in this package, at noon on the day it was issued. Regenerated after every signing.",
      nowSeconds: seconds(`${committed.issuedAt}T12:00:00Z`),
      bundledSequence: committed.sequence,
      publicKeys: [...REGISTRY_SIGNING_KEYS],
      registry: committedRegistry,
      signature: committed,
    },
    committed.sequence
  );

  return {
    schema: 1,
    name: "registry-signing-v1",
    description:
      "Conformance vectors for the exchange registry signature. For each vector, take the five fields version, lastVerified, validUntil, source and entries of registry, build the document { format: 1, issuedAt, registry, sequence } from the envelope in signature, write it as canonical JSON (keys in UTF-16 code unit order, no whitespace, integers only), prefix it with the label and a newline, and check the Ed25519 signature (base64, exactly 64 bytes, canonical encoding) against each of publicKeys. A document is accepted only when a key verifies it, its sequence is at least bundledSequence, validUntil has not passed at nowSeconds (the whole day counts), and issuedAt is no more than one day after nowSeconds. A reject carries the reason its check must report. A missing signature is a reject. Every key is public.",
    generator: "packages/verify/scripts/generate-vectors.ts",
    label: SIGNING_LABEL,
    vectors,
  };
}
