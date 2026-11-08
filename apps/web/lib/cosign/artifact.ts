import { StrKey, xdr } from "@stellar/stellar-sdk";
import type { Network } from "@/config/networks";

/**
 * The cosign artifact (docs/multisig-cosigning.md Section 6): one transaction envelope crossing
 * devices as a strict, flat JSON document. Every received artifact is untrusted input.
 */

export const COSIGN_FORMAT = "lumenwipe-cosign";
export const COSIGN_VERSION = 1;

// Above the network's per-transaction size limit (tx_max_size_bytes, 132,096 bytes on mainnet and
// testnet), with base64's extra third and the JSON around it, with margin.
export const COSIGN_ARTIFACT_MAX_BYTES = 256 * 1024;

export type CosignDirection = "request" | "response";

export interface CosignArtifact {
  direction: CosignDirection;
  network: Network;
  account: string;
  /** Base64 `TransactionEnvelope` XDR of a plain (non-fee-bump) transaction. */
  envelope: string;
}

export type CosignArtifactErrorCode =
  | "too_large"
  | "not_json"
  | "unknown_field"
  | "missing_field"
  | "duplicate_field"
  | "wrong_type"
  | "unknown_format"
  | "unknown_version"
  | "unknown_direction"
  | "wrong_direction"
  | "unknown_network"
  | "invalid_account"
  | "invalid_envelope"
  | "fee_bump"
  | "request_signed"
  | "response_unsigned";

const MESSAGES: Record<CosignArtifactErrorCode, string> = {
  too_large: "This file is too large to be a LumenWipe cosign file.",
  not_json: "This is not a LumenWipe cosign file.",
  unknown_field: "This cosign file has a field LumenWipe does not accept.",
  missing_field: "This cosign file is missing a field.",
  duplicate_field: "This cosign file repeats a field.",
  wrong_type: "This cosign file has a field of the wrong kind.",
  unknown_format: "This is not a LumenWipe cosign file.",
  unknown_version: "This cosign file is from a version LumenWipe does not support.",
  unknown_direction: "This cosign file is neither a request nor a response.",
  wrong_direction: "This is a cosign file of the other kind. Check which file you imported.",
  unknown_network: "This cosign file names a network LumenWipe does not support.",
  invalid_account: "This cosign file does not name a valid Stellar account.",
  invalid_envelope: "This cosign file does not hold a readable transaction.",
  fee_bump: "This cosign file holds a fee-bump transaction, which cannot be cosigned.",
  request_signed: "This request already carries signatures. Ask for a new one.",
  response_unsigned: "This response carries no signature.",
};

export class CosignArtifactError extends Error {
  constructor(public readonly code: CosignArtifactErrorCode) {
    super(MESSAGES[code]);
    this.name = "CosignArtifactError";
  }
}

const FIELDS = ["format", "version", "direction", "network", "account", "envelope"] as const;
type Field = (typeof FIELDS)[number];
type Literal = { kind: "string" | "number"; text: string };
const FIELD_SET: ReadonlySet<string> = new Set(FIELDS);

const WIRE_TO_NETWORK: Record<string, Network> = { public: "mainnet", testnet: "testnet" };
const NETWORK_TO_WIRE: Record<Network, string> = { mainnet: "public", testnet: "testnet" };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const LITERALS = ["true", "false", "null"];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function fail(code: CosignArtifactErrorCode): never {
  throw new CosignArtifactError(code);
}

function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Reads one JSON object whose values are string or number literals only (RFC 8259 grammar), in a
 * single pass with no recursion. `JSON.parse` is not used: it keeps the last of two equal keys
 * without a word, and a nested value has no place in an artifact.
 */
function scanFlatObject(text: string): Map<Field, Literal> {
  const out = new Map<Field, Literal>();
  let i = 0;
  const skipSpace = (): void => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };
  const expect = (char: string): void => {
    if (text[i] !== char) fail("not_json");
    i++;
  };
  const readString = (): string => {
    expect('"');
    let value = "";
    for (;;) {
      if (i >= text.length) fail("not_json");
      const char = text[i]!;
      if (char === '"') {
        i++;
        break;
      }
      if (char.charCodeAt(0) < 0x20) fail("not_json");
      if (char !== "\\") {
        value += char;
        i++;
        continue;
      }
      const escape = text[i + 1];
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!HEX4.test(hex)) fail("not_json");
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (escape !== undefined && Object.hasOwn(SIMPLE_ESCAPES, escape)) {
        value += SIMPLE_ESCAPES[escape];
        i += 2;
      } else {
        fail("not_json");
      }
    }
    if (!isWellFormed(value)) fail("not_json");
    return value;
  };

  skipSpace();
  expect("{");
  skipSpace();
  if (text[i] === "}") {
    i++;
  } else {
    for (;;) {
      skipSpace();
      const key = readString();
      if (!FIELD_SET.has(key)) fail("unknown_field");
      if (out.has(key as Field)) fail("duplicate_field");
      skipSpace();
      expect(":");
      skipSpace();
      const start = text[i];
      if (start === '"') {
        out.set(key as Field, { kind: "string", text: readString() });
      } else {
        NUMBER.lastIndex = i;
        const match = NUMBER.exec(text);
        if (match) {
          // Kept as written, so the version must be the literal 1 and not an equal number.
          out.set(key as Field, { kind: "number", text: match[0] });
          i += match[0].length;
        } else if (start === "{" || start === "[" || LITERALS.some((l) => text.startsWith(l, i))) {
          fail("wrong_type");
        } else {
          fail("not_json");
        }
      }
      skipSpace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      expect("}");
      break;
    }
  }
  skipSpace();
  if (i !== text.length) fail("not_json");
  return out;
}

function literalField(fields: Map<Field, Literal>, name: Field, kind: Literal["kind"]): string {
  const value = fields.get(name);
  if (value?.kind !== kind) fail("wrong_type");
  return value.text;
}

function decodeEnvelope(envelope: string): xdr.TransactionEnvelope {
  if (envelope === "" || !BASE64.test(envelope)) fail("invalid_envelope");
  let decoded: xdr.TransactionEnvelope;
  try {
    decoded = xdr.TransactionEnvelope.fromXDR(envelope, "base64");
  } catch {
    fail("invalid_envelope");
  }
  if (decoded.toXDR("base64") !== envelope) fail("invalid_envelope");
  return decoded;
}

function exceedsCap(text: string): boolean {
  // Every UTF-16 unit is at least one UTF-8 byte: a longer string is refused before encoding.
  if (text.length > COSIGN_ARTIFACT_MAX_BYTES) return true;
  return new TextEncoder().encode(text).length > COSIGN_ARTIFACT_MAX_BYTES;
}

/**
 * Parses an artifact received from another device, as untrusted input, and accepts it only as the
 * `expected` direction. The size cap is applied before anything is read. Throws
 * `CosignArtifactError` for every refusal.
 */
export function parseCosignArtifact(text: string, expected: CosignDirection): CosignArtifact {
  if (exceedsCap(text)) fail("too_large");
  const fields = scanFlatObject(text);
  for (const name of FIELDS) if (!fields.has(name)) fail("missing_field");
  const format = literalField(fields, "format", "string");
  const version = literalField(fields, "version", "number");
  const direction = literalField(fields, "direction", "string");
  const wireNetwork = literalField(fields, "network", "string");
  const account = literalField(fields, "account", "string");
  const envelope = literalField(fields, "envelope", "string");

  if (format !== COSIGN_FORMAT) fail("unknown_format");
  if (version !== String(COSIGN_VERSION)) fail("unknown_version");
  if (direction !== "request" && direction !== "response") fail("unknown_direction");
  if (direction !== expected) fail("wrong_direction");
  if (!Object.hasOwn(WIRE_TO_NETWORK, wireNetwork)) fail("unknown_network");
  if (!StrKey.isValidEd25519PublicKey(account)) fail("invalid_account");

  const decoded = decodeEnvelope(envelope);
  if (decoded.type === "envelopeTypeTxFeeBump") fail("fee_bump");
  if (decoded.type !== "envelopeTypeTx") fail("invalid_envelope");
  const signatures = decoded.v1.signatures.length;
  if (direction === "request" && signatures > 0) fail("request_signed");
  if (direction === "response" && signatures === 0) fail("response_unsigned");

  return { direction, network: WIRE_TO_NETWORK[wireNetwork]!, account, envelope };
}

/**
 * The artifact as the text another device imports. It holds exactly the six fields and nothing
 * else, and is parsed back before it is handed out, so an artifact this device could not accept is
 * never produced.
 */
export function serializeCosignArtifact(artifact: CosignArtifact): string {
  const text = JSON.stringify(
    {
      format: COSIGN_FORMAT,
      version: COSIGN_VERSION,
      direction: artifact.direction,
      network: NETWORK_TO_WIRE[artifact.network],
      account: artifact.account,
      envelope: artifact.envelope,
    },
    null,
    2
  );
  parseCosignArtifact(text, artifact.direction);
  return text;
}

/** Reads an imported file, refusing one above the cap before any of it is read. */
export async function readCosignFile(file: Blob): Promise<string> {
  if (file.size > COSIGN_ARTIFACT_MAX_BYTES) fail("too_large");
  return file.text();
}
