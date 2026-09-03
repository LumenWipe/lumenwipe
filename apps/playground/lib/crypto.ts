import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Server-only. Secrets are encrypted at rest in KV with AES-256-GCM; the key
// lives in PLAYGROUND_ENCRYPTION_KEY (64 hex chars) and is never bundled
// client-side (no NEXT_PUBLIC_ prefix).

export class PlaygroundConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundConfigError";
  }
}

function getKey(): Buffer {
  const hex = process.env.PLAYGROUND_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new PlaygroundConfigError(
      "PLAYGROUND_ENCRYPTION_KEY must be set to 64 hex characters (32 bytes)"
    );
  }
  return Buffer.from(hex, "hex");
}

// GCM's default tag length (16 bytes) is already what Node enforces when this option is
// omitted, so this doesn't change behavior - it makes the expected tag length an explicit,
// auditable part of the encrypt/decrypt contract instead of an implicit runtime default,
// closing a semgrep finding (gcm-no-tag-length) that flags the implicit form on principle.
const GCM_AUTH_TAG_LENGTH = 16;

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"), {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString(
    "utf8"
  );
}
