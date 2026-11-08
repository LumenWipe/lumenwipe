import { describe, expect, test } from "bun:test";
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  COSIGN_ARTIFACT_MAX_BYTES,
  CosignArtifactError,
  parseCosignArtifact,
  readCosignFile,
  serializeCosignArtifact,
  type CosignArtifact,
  type CosignArtifactErrorCode,
} from "@/lib/cosign/artifact";

const source = Keypair.random();
const signer = Keypair.random();

function unsignedTx() {
  return new TransactionBuilder(new Account(source.publicKey(), "41"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }))
    .setTimeout(300)
    .build();
}

const UNSIGNED = unsignedTx().toEnvelope().toXDR("base64");
const SIGNED = (() => {
  const tx = unsignedTx();
  tx.sign(signer);
  return tx.toEnvelope().toXDR("base64");
})();
const FEE_BUMP = (() => {
  const inner = unsignedTx();
  inner.sign(signer);
  const bump: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
    signer,
    "200",
    inner,
    Networks.TESTNET
  );
  return bump.toEnvelope().toXDR("base64");
})();

// The same transaction as a v0 envelope: a v1 envelope's first eight bytes are its type and the
// muxed source's key type, where a v0 envelope has only its own type before the raw key.
const V0 = Buffer.concat([Buffer.alloc(4), Buffer.from(UNSIGNED, "base64").subarray(8)]).toString(
  "base64"
);

const REQUEST: Record<string, unknown> = {
  format: "lumenwipe-cosign",
  version: 1,
  direction: "request",
  network: "testnet",
  account: source.publicKey(),
  envelope: UNSIGNED,
};

function text(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function refusal(input: string, direction: "request" | "response" = "request"): string {
  try {
    parseCosignArtifact(input, direction);
  } catch (err) {
    if (err instanceof CosignArtifactError) return err.code;
    throw err;
  }
  throw new Error("accepted");
}

describe("parseCosignArtifact", () => {
  test("accepts a well-formed request and maps the network", () => {
    expect(parseCosignArtifact(text(REQUEST), "request")).toEqual({
      direction: "request",
      network: "testnet",
      account: source.publicKey(),
      envelope: UNSIGNED,
    });
    expect(parseCosignArtifact(text({ ...REQUEST, network: "public" }), "request").network).toBe(
      "mainnet"
    );
  });

  test("accepts a response that carries a signature", () => {
    const response = text({ ...REQUEST, direction: "response", envelope: SIGNED });
    expect(parseCosignArtifact(response, "response").envelope).toBe(SIGNED);
  });

  test("refuses input over the cap before reading it", () => {
    const padded = text(REQUEST).replace("{", "{" + " ".repeat(COSIGN_ARTIFACT_MAX_BYTES));
    expect(refusal(padded)).toBe("too_large");
    // A cap measured in UTF-16 units would let this through: 3 bytes per character.
    const wide = '"' + "€".repeat(COSIGN_ARTIFACT_MAX_BYTES / 3 + 1) + '"';
    expect(wide.length).toBeLessThan(COSIGN_ARTIFACT_MAX_BYTES);
    expect(refusal(wide)).toBe("too_large");
  });

  test("refuses a file over the cap without reading it", async () => {
    let read = false;
    const file = {
      size: COSIGN_ARTIFACT_MAX_BYTES + 1,
      text: async () => {
        read = true;
        return "";
      },
    } as unknown as Blob;
    await expect(readCosignFile(file)).rejects.toThrow(CosignArtifactError);
    expect(read).toBe(false);
  });

  const cases: [string, string, CosignArtifactErrorCode][] = [
    ["empty", "", "not_json"],
    ["not an object", "[]", "not_json"],
    ["trailing text", text(REQUEST) + "x", "not_json"],
    ["trailing comma", text(REQUEST).replace(/}$/, ",}"), "not_json"],
    ["single quotes", "{'format':1}", "not_json"],
    ["unknown field", text({ ...REQUEST, url: "https://example.com" }), "unknown_field"],
    ["hash field", text({ ...REQUEST, hash: "00" }), "unknown_field"],
    ["prototype key", text(REQUEST).replace("{", '{"__proto__":"x",'), "unknown_field"],
    ["constructor key", text(REQUEST).replace("{", '{"constructor":"x",'), "unknown_field"],
    ["missing field", text({ ...REQUEST, envelope: undefined }), "missing_field"],
    ["empty object", "{}", "missing_field"],
    ["duplicate key", text(REQUEST).replace("{", '{"account":"x",'), "duplicate_field"],
    ["nested object", text({ ...REQUEST, envelope: { a: 1 } }), "wrong_type"],
    ["nested array", text({ ...REQUEST, envelope: [UNSIGNED] }), "wrong_type"],
    ["boolean", text({ ...REQUEST, version: true }), "wrong_type"],
    ["null", text({ ...REQUEST, account: null }), "wrong_type"],
    ["version as string", text({ ...REQUEST, version: "1" }), "wrong_type"],
    ["format as number", text({ ...REQUEST, format: 1 }), "wrong_type"],
    ["unknown format", text({ ...REQUEST, format: "other" }), "unknown_format"],
    ["unknown version", text({ ...REQUEST, version: 2 }), "unknown_version"],
    ["fractional version", text({ ...REQUEST, version: 1.5 }), "unknown_version"],
    [
      "version written 1.0",
      text(REQUEST).replace('"version":1', '"version":1.0'),
      "unknown_version",
    ],
    [
      "version written 1e0",
      text(REQUEST).replace('"version":1', '"version":1e0'),
      "unknown_version",
    ],
    ["v0 envelope", text({ ...REQUEST, envelope: V0 }), "invalid_envelope"],
    ["unknown direction", text({ ...REQUEST, direction: "relay" }), "unknown_direction"],
    ["unknown network", text({ ...REQUEST, network: "mainnet" }), "unknown_network"],
    [
      "secret key as account",
      text({ ...REQUEST, account: "S" + "A".repeat(55) }),
      "invalid_account",
    ],
    ["muxed account", text({ ...REQUEST, account: "M" + "A".repeat(68) }), "invalid_account"],
    ["envelope not base64", text({ ...REQUEST, envelope: "%%%" }), "invalid_envelope"],
    ["envelope empty", text({ ...REQUEST, envelope: "" }), "invalid_envelope"],
    ["envelope not xdr", text({ ...REQUEST, envelope: "AAAA" }), "invalid_envelope"],
    [
      "envelope with trailing bytes",
      text({ ...REQUEST, envelope: UNSIGNED.replace(/=*$/, "") + "AAAA" }),
      "invalid_envelope",
    ],
    ["fee bump", text({ ...REQUEST, direction: "response", envelope: FEE_BUMP }), "fee_bump"],
    ["signed request", text({ ...REQUEST, envelope: SIGNED }), "request_signed"],
  ];
  for (const [name, input, code] of cases) {
    test(`refuses ${name} as ${code}`, () => {
      const direction = code === "fee_bump" ? "response" : "request";
      expect(refusal(input, direction)).toBe(code);
    });
  }

  test("refuses a response with no signature, and the other direction", () => {
    expect(refusal(text({ ...REQUEST, direction: "response" }), "response")).toBe(
      "response_unsigned"
    );
    expect(refusal(text(REQUEST), "response")).toBe("wrong_direction");
  });

  test("refuses deep nesting without recursing", () => {
    const deep = '{"envelope":' + "[".repeat(100_000) + "]".repeat(100_000) + "}";
    expect(refusal(deep)).toBe("wrong_type");
  });

  test("refuses a huge string under the cap as an invalid envelope", () => {
    expect(refusal(text({ ...REQUEST, envelope: "A".repeat(200_000) }))).toBe("invalid_envelope");
  });

  test("reads RFC 8259 escapes and refuses lone surrogates", () => {
    const escaped = text(REQUEST).replace('"lumenwipe-cosign"', '"lumenwipe\\u002dcosign"');
    expect(parseCosignArtifact(escaped, "request").account).toBe(source.publicKey());
    const pair = text({ ...REQUEST, format: "😀" });
    expect(refusal(pair)).toBe("unknown_format");
    expect(refusal(text(REQUEST).replace('"testnet"', '"\\ud800"'))).toBe("not_json");
    expect(refusal(text(REQUEST).replace('"testnet"', '"\\udc00x"'))).toBe("not_json");
    expect(refusal(text(REQUEST).replace('"testnet"', '"\ud800"'))).toBe("not_json");
    expect(refusal(text(REQUEST).replace('"testnet"', '"\\x41"'))).toBe("not_json");
    expect(refusal(text(REQUEST).replace('"testnet"', '"\\u00g1"'))).toBe("not_json");
    expect(refusal(text(REQUEST).replace('"testnet"', '"test\nnet"'))).toBe("not_json");
  });

  test("returns a valid artifact or throws CosignArtifactError, for random and truncated input", () => {
    const base = text(REQUEST);
    const alphabet = '{}[]":,\\u0123456789abcdefABCDEF -+.eEtrufalsn\n\t\ud800';
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const inputs: string[] = [];
    for (let cut = 0; cut <= base.length; cut++) inputs.push(base.slice(0, cut));
    for (let n = 0; n < 2_000; n++) {
      const chars = Array.from({ length: random(60) }, () => alphabet[random(alphabet.length)]);
      inputs.push(chars.join(""));
      const at = random(base.length);
      inputs.push(base.slice(0, at) + alphabet[random(alphabet.length)] + base.slice(at + 1));
    }
    for (const input of inputs) {
      for (const direction of ["request", "response"] as const) {
        let result: CosignArtifact;
        try {
          result = parseCosignArtifact(input, direction);
        } catch (err) {
          expect(err).toBeInstanceOf(CosignArtifactError);
          continue;
        }
        expect(Object.keys(result).sort()).toEqual(["account", "direction", "envelope", "network"]);
        expect(result.direction).toBe(direction);
      }
    }
  });
});

describe("serializeCosignArtifact", () => {
  const artifact: CosignArtifact = {
    direction: "request",
    network: "mainnet",
    account: source.publicKey(),
    envelope: UNSIGNED,
  };

  test("round-trips and writes exactly the six fields", () => {
    const serialized = serializeCosignArtifact(artifact);
    expect(parseCosignArtifact(serialized, "request")).toEqual(artifact);
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "format",
      "version",
      "direction",
      "network",
      "account",
      "envelope",
    ]);
    expect(JSON.parse(serialized).network).toBe("public");
  });

  test("never adds a field the input carries", () => {
    const extra = { ...artifact, url: "https://example.com", hash: "ab", fingerprint: "cd" };
    const serialized = serializeCosignArtifact(extra);
    expect(serialized).not.toContain("url");
    expect(serialized).not.toContain("hash");
    expect(serialized).not.toContain("fingerprint");
  });

  test("refuses to write a request that carries signatures", () => {
    expect(() => serializeCosignArtifact({ ...artifact, envelope: SIGNED })).toThrow(
      CosignArtifactError
    );
  });
});
