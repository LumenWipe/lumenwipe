import { describe, expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { parseCosignArtifact, type CosignArtifact } from "@/lib/cosign/artifact";
import {
  assertSigningTime,
  assertStationSigner,
  checkRequest,
  fingerprintMatches,
  fingerprintOf,
  REFUSED,
  responseFromSigned,
  type CheckedRequest,
  type LiveAccount,
} from "@/lib/cosign/station-checks";
import { toHex } from "@/lib/stellar/hex";
import { UserFacingError } from "@/lib/utils/user-error";

const master = Keypair.random();
const cosignerB = Keypair.random();
const cosignerC = Keypair.random();
const ACCOUNT = master.publicKey();
const NOW = Math.floor(Date.now() / 1000);

const LIVE: LiveAccount = {
  sequence: "100",
  authImmutable: false,
  signers: [
    { key: ACCOUNT, weight: 1, type: "ed25519_public_key" },
    { key: cosignerB.publicKey(), weight: 1, type: "ed25519_public_key" },
    { key: cosignerC.publicKey(), weight: 1, type: "ed25519_public_key" },
  ],
  thresholds: { low: 0, med: 3, high: 3 },
};

const removal = (key: string): xdr.Operation =>
  Operation.setOptions({ signer: { ed25519PublicKey: key, weight: 0 } });
const RESET = Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 });
const NORMALIZATION = [removal(cosignerB.publicKey()), removal(cosignerC.publicKey()), RESET];

interface Build {
  ops?: xdr.Operation[];
  configure?: (builder: TransactionBuilder) => void;
  source?: string;
  sequence?: string;
  minTime?: number;
  maxTime?: number;
  fee?: string;
  passphrase?: string;
}

function buildTx(options: Build = {}) {
  const builder = new TransactionBuilder(
    new Account(options.source ?? ACCOUNT, options.sequence ?? "100"),
    { fee: options.fee ?? "100", networkPassphrase: options.passphrase ?? Networks.TESTNET }
  ).setTimebounds(options.minTime ?? 0, options.maxTime ?? NOW + 300);
  for (const op of options.ops ?? NORMALIZATION) builder.addOperation(op);
  options.configure?.(builder);
  return builder.build();
}

function request(options: Build = {}, overrides: Partial<CosignArtifact> = {}): CosignArtifact {
  return {
    direction: "request",
    network: "testnet",
    account: ACCOUNT,
    envelope: buildTx(options).toEnvelope().toXDR("base64"),
    ...overrides,
  };
}

function check(artifact: CosignArtifact, live: LiveAccount = LIVE, account = ACCOUNT) {
  return checkRequest({ artifact, network: "testnet", account, live, nowSeconds: NOW });
}

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof UserFacingError) return err.message;
    throw err;
  }
  throw new Error("accepted");
}

describe("checkRequest", () => {
  test("accepts a signer normalization and summarizes it", () => {
    const checked = check(request());
    expect(checked.hash).toBe(toHex(buildTx().hash()));
    expect(checked.summary).toEqual({
      master: ACCOUNT,
      removedSigners: [
        { key: cosignerB.publicKey(), weight: 0, type: "ed25519_public_key" },
        { key: cosignerC.publicKey(), weight: 0, type: "ed25519_public_key" },
      ],
      thresholds: { low: 0, med: 1, high: 1 },
      feeStroops: "300",
    });
  });

  test("refuses a request for another network", () => {
    expect(refusalOf(() => check(request({}, { network: "mainnet" })))).toBe(REFUSED.network);
  });

  test("refuses a request for another account than the one typed", () => {
    const other = Keypair.random().publicKey();
    const forOther = request({ source: other }, { account: other });
    expect(refusalOf(() => check(forOther))).toBe(REFUSED.account);
    expect(refusalOf(() => check(request({}, { account: other })))).toBe(REFUSED.account);
    expect(refusalOf(() => check(request({ source: other })))).toBe(REFUSED.account);
  });

  test("refuses a request that carries a signature", () => {
    const tx = buildTx();
    tx.sign(cosignerB);
    const signed = { ...request(), envelope: tx.toEnvelope().toXDR("base64") };
    expect(refusalOf(() => check(signed))).toMatch(/already carries signatures/);
  });

  test("refuses a transaction that is not on the account's next sequence number", () => {
    expect(refusalOf(() => check(request({ sequence: "101" })))).toBe(REFUSED.sequence);
    expect(refusalOf(() => check(request({ sequence: "99" })))).toBe(REFUSED.sequence);
  });

  test("refuses an account the API's normalization safety rules would refuse", () => {
    expect(refusalOf(() => check(request(), { ...LIVE, authImmutable: true }))).toBe(
      REFUSED.closeBlocked
    );
    const weightless = LIVE.signers.map((s) => (s.key === ACCOUNT ? { ...s, weight: 0 } : s));
    expect(refusalOf(() => check(request(), { ...LIVE, signers: weightless }))).toBe(
      REFUSED.masterWeightZero
    );
    const unreachable = { ...LIVE, thresholds: { low: 0, med: 3, high: 4 } };
    expect(refusalOf(() => check(request(), unreachable))).toBe(REFUSED.unreachable);
  });

  test("refuses a request with too little time left or not valid yet", () => {
    expect(refusalOf(() => check(request({ maxTime: NOW + 89 })))).toBe(REFUSED.expiresSoon);
    expect(() => check(request({ maxTime: NOW + 90 }))).not.toThrow();
    expect(refusalOf(() => check(request({ maxTime: 0 })))).toBe(REFUSED.expiresSoon);
    expect(refusalOf(() => check(request({ minTime: NOW + 10 })))).toBe(REFUSED.notYetValid);
  });

  const destination = Keypair.random().publicKey();
  const notNormalization: [string, xdr.Operation[]][] = [
    [
      "a payment",
      [...NORMALIZATION, Operation.payment({ destination, asset: Asset.native(), amount: "1" })],
    ],
    ["a merge", [...NORMALIZATION, Operation.accountMerge({ destination })]],
    [
      "a trustline change",
      [
        ...NORMALIZATION,
        Operation.changeTrust({ asset: new Asset("ABC", destination), limit: "0" }),
      ],
    ],
    ["a master weight change", [...NORMALIZATION, Operation.setOptions({ masterWeight: 2 })]],
    ["a home domain", [...NORMALIZATION, Operation.setOptions({ homeDomain: "example.com" })]],
    ["no threshold reset", [removal(cosignerB.publicKey())]],
    ["two threshold resets", [...NORMALIZATION, RESET]],
    [
      "thresholds above the master key's weight",
      [
        removal(cosignerB.publicKey()),
        Operation.setOptions({ lowThreshold: 0, medThreshold: 2, highThreshold: 2 }),
      ],
    ],
    [
      "a partial threshold change",
      [removal(cosignerB.publicKey()), Operation.setOptions({ highThreshold: 1 })],
    ],
    [
      "a signer added",
      [Operation.setOptions({ signer: { ed25519PublicKey: destination, weight: 1 } }), RESET],
    ],
    ["an unknown signer removed", [removal(destination), RESET]],
    [
      "an operation of another account",
      [
        Operation.setOptions({
          source: destination,
          lowThreshold: 0,
          medThreshold: 1,
          highThreshold: 1,
        }),
      ],
    ],
  ];
  for (const [name, ops] of notNormalization) {
    test(`refuses a request holding ${name}`, () => {
      expect(refusalOf(() => check(request({ ops })))).toBe(REFUSED.notNormalization);
    });
  }

  test("refuses a precondition other than time bounds", () => {
    const configs: ((b: TransactionBuilder) => void)[] = [
      (b) => b.setLedgerbounds(1, 0),
      (b) => b.setMinAccountSequence("1"),
      (b) => b.setMinAccountSequenceAge(BigInt(1)),
      (b) => b.setMinAccountSequenceLedgerGap(1),
      (b) => b.setExtraSigners([cosignerB.publicKey()]),
    ];
    for (const configure of configs) {
      expect(refusalOf(() => check(request({ configure })))).toBe(REFUSED.notNormalization);
    }
  });

  test("refuses an operation sourced from a muxed form of the account", () => {
    const muxed = new MuxedAccount(new Account(ACCOUNT, "0"), "7").accountId();
    const ops = [
      Operation.setOptions({
        source: muxed,
        lowThreshold: 0,
        medThreshold: 1,
        highThreshold: 1,
      }),
    ];
    expect(refusalOf(() => check(request({ ops })))).toBe(REFUSED.notNormalization);
  });

  test("refuses with verify()'s own message when verify() refuses", () => {
    expect(refusalOf(() => check(request({ fee: "100000000" })))).toMatch(/network fee/);
    expect(refusalOf(() => check(request({ maxTime: NOW + 3600 })))).toMatch(/far longer/);
  });

  test("checks the hash over the chosen network's passphrase", () => {
    const checked = check(request());
    const mainnetHash = toHex(buildTx({ passphrase: Networks.PUBLIC }).hash());
    expect(checked.hash).not.toBe(mainnetHash);
  });
});

describe("fingerprint", () => {
  const hash = "0123456789abcdef".repeat(4);

  test("is the first and last eight characters of the hash", () => {
    expect(fingerprintOf(hash)).toBe("0123456789abcdef");
  });

  test("matches the typed characters, ignoring case, spaces and the ellipsis", () => {
    expect(fingerprintMatches("01234567 89ABCDEF", hash)).toBe(true);
    expect(fingerprintMatches("01234567…89abcdef", hash)).toBe(true);
  });

  test("does not match when only the first eight characters agree", () => {
    expect(fingerprintMatches("0123456700000000", hash)).toBe(false);
    expect(fingerprintMatches("01234567", hash)).toBe(false);
    expect(fingerprintMatches("", hash)).toBe(false);
  });
});

describe("assertStationSigner and assertSigningTime", () => {
  test("accepts only an ed25519 signer of the account with weight", () => {
    expect(() => assertStationSigner(LIVE, cosignerB.publicKey())).not.toThrow();
    expect(refusalOf(() => assertStationSigner(LIVE, Keypair.random().publicKey()))).toBe(
      REFUSED.notSigner
    );
    const weightless = {
      ...LIVE,
      signers: LIVE.signers.map((s) => ({ ...s, weight: 0 })),
    };
    expect(refusalOf(() => assertStationSigner(weightless, cosignerB.publicKey()))).toBe(
      REFUSED.notSigner
    );
  });

  test("refuses to ask the signer with less than 60 seconds left", () => {
    const checked = check(request());
    expect(refusalOf(() => assertSigningTime({ ...checked, maxTime: NOW + 59 }, NOW))).toBe(
      REFUSED.tooLittleTime
    );
    expect(() => assertSigningTime({ ...checked, maxTime: NOW + 60 }, NOW)).not.toThrow();
  });
});

describe("responseFromSigned", () => {
  function signedBy(...keys: Keypair[]): string {
    const tx = buildTx();
    for (const key of keys) tx.sign(key);
    return tx.toEnvelope().toXDR("base64");
  }
  const checked = (): CheckedRequest => check(request());

  test("returns only the named signer's signature on the request's envelope", () => {
    const text = responseFromSigned({
      request: checked(),
      signedXdr: signedBy(cosignerB),
      live: LIVE,
      signerKey: cosignerB.publicKey(),
    });
    const response = parseCosignArtifact(text, "response");
    const tx = TransactionBuilder.fromXdr(response.envelope, Networks.TESTNET);
    expect(toHex(tx.hash())).toBe(checked().hash);
    expect(tx.signatures).toHaveLength(1);
    expect(cosignerB.verify(tx.hash(), Buffer.from(tx.signatures[0]!.signature.toBytes()))).toBe(
      true
    );
  });

  test("drops a signature from another key that the signer added", () => {
    const text = responseFromSigned({
      request: checked(),
      signedXdr: signedBy(cosignerC, cosignerB),
      live: LIVE,
      signerKey: cosignerB.publicKey(),
    });
    const tx = TransactionBuilder.fromXdr(
      parseCosignArtifact(text, "response").envelope,
      Networks.TESTNET
    );
    expect(tx.signatures).toHaveLength(1);
    expect(cosignerB.verify(tx.hash(), Buffer.from(tx.signatures[0]!.signature.toBytes()))).toBe(
      true
    );
  });

  test("refuses a signed transaction that is not the one approved", () => {
    const other = buildTx({ maxTime: NOW + 200 });
    other.sign(cosignerB);
    expect(
      refusalOf(() =>
        responseFromSigned({
          request: checked(),
          signedXdr: other.toEnvelope().toXDR("base64"),
          live: LIVE,
          signerKey: cosignerB.publicKey(),
        })
      )
    ).toBe(REFUSED.notApproved);
  });

  test("refuses when the weight did not rise by the named signer's signature", () => {
    for (const signedXdr of [signedBy(), signedBy(cosignerC), "not xdr"]) {
      expect(
        refusalOf(() =>
          responseFromSigned({
            request: checked(),
            signedXdr,
            live: LIVE,
            signerKey: cosignerB.publicKey(),
          })
        )
      ).toBe(REFUSED.notApproved);
    }
  });
});
