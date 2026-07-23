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

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString(
    "utf8"
  );
}
