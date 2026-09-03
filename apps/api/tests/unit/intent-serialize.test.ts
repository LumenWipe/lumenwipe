import { test, expect } from "bun:test";
import {
  Account,
  Address,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Keypair,
  StrKey,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function txWith(...ops: ReturnType<typeof Operation.accountMerge>[]): string {
  const account = new Account(SRC, "100");
  const b = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) b.addOperation(op);
  return b.build().toEnvelope().toXDR("base64");
}

test("intentFromXdr normalizes change_trust and account_merge", () => {
  const xdr = txWith(
    Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }),
    Operation.accountMerge({ destination: DEST })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.source).toBe(SRC);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "change_trust",
    asset: `USDC:${ISSUER}`,
    limit: "0.0000000",
  });
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "account_merge",
    destination: DEST,
  });
  expect(intent.guarantees.mergeDestination).toBe(DEST);
});

test("intentFromXdr captures the conversion floor and self-payment destination", () => {
  const xdr = txWith(
    Operation.pathPaymentStrictSend({
      sendAsset: new Asset("USDC", ISSUER),
      sendAmount: "120.50",
      destination: SRC,
      destAsset: Asset.native(),
      destMin: "118.20",
      path: [],
    }),
    Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }),
    Operation.accountMerge({ destination: DEST })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.operations[0]).toEqual({
    source: SRC,
    type: "path_payment_strict_send",
    sendAsset: `USDC:${ISSUER}`,
    sendAmount: "120.5000000",
    destination: SRC,
    destAsset: "native",
    destMin: "118.2000000",
    path: [],
  });
  expect(intent.guarantees.minXlmFromConversions).toBe("118.2000000");
  expect(intent.guarantees.paymentsOnlyTo).toContain(SRC);
  expect(intent.guarantees.mergeDestination).toBe(DEST);
});

test("intentFromXdr returns null merge destination when there is no merge", () => {
  const xdr = txWith(Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }));
  const intent = intentFromXdr(xdr, Networks.TESTNET);
  expect(intent.guarantees.mergeDestination).toBeNull();
  expect(intent.guarantees.minXlmFromConversions).toBeNull();
});

test("intentFromXdr normalizes revokeAccountSponsorship operation", () => {
  const sponsor = Keypair.random().publicKey();
  const xdr = txWith(Operation.revokeAccountSponsorship({ account: sponsor }));
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "revoke_sponsorship",
    entryKind: "account",
    owner: sponsor,
  });
});

test("intentFromXdr normalizes all revoke-sponsorship operation types", () => {
  const account = Keypair.random().publicKey();
  const seller = Keypair.random().publicKey();
  const signer = Keypair.random().publicKey();

  const xdr = txWith(
    Operation.revokeAccountSponsorship({ account }),
    Operation.revokeTrustlineSponsorship({ account, asset: new Asset("USDC", ISSUER) }),
    Operation.revokeOfferSponsorship({ seller, offerId: "12345" }),
    Operation.revokeDataSponsorship({ account, name: "test" }),
    Operation.revokeSignerSponsorship({ account, signer: { ed25519PublicKey: signer } })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "revoke_sponsorship",
    entryKind: "account",
    owner: account,
  });
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "revoke_sponsorship",
    entryKind: "trustline",
    owner: account,
  });
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "revoke_sponsorship",
    entryKind: "offer",
    owner: seller,
  });
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "revoke_sponsorship",
    entryKind: "data_entry",
    owner: account,
  });
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "revoke_sponsorship",
    entryKind: "signer",
    owner: account,
  });
});

test("intentFromXdr decodes an ed25519 signer removal with its type and key", () => {
  const signerKey = Keypair.random().publicKey();
  const txXdr = txWith(
    Operation.setOptions({ signer: { ed25519PublicKey: signerKey, weight: 0 } })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "set_options",
    signer: { type: "ed25519_public_key", key: signerKey, weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  });
});

test("intentFromXdr decodes a hash(x) signer removal, re-encoding the raw hash to strkey", () => {
  const rawHash = Keypair.random().rawPublicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { sha256Hash: rawHash, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "set_options",
    signer: { type: "hash_x", key: StrKey.encodeSha256Hash(rawHash), weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  });
});

test("intentFromXdr decodes a pre-auth-tx signer removal, re-encoding the raw hash to strkey", () => {
  const rawHash = Keypair.random().rawPublicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { preAuthTx: rawHash, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "set_options",
    signer: { type: "preauth_tx", key: StrKey.encodePreAuthTx(rawHash), weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  });
});

test("intentFromXdr decodes an ed25519 signed-payload (CAP-40) signer removal", () => {
  const payloadXdr = new xdr.SignerKeyEd25519SignedPayload({
    ed25519: Keypair.random().rawPublicKey(),
    payload: Buffer.from("cafebabe", "hex"),
  }).toXDR();
  const signedPayloadKey = StrKey.encodeSignedPayload(payloadXdr);
  const txXdr = txWith(
    Operation.setOptions({ signer: { ed25519SignedPayload: signedPayloadKey, weight: 0 } })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "set_options",
    signer: { type: "ed25519_signed_payload", key: signedPayloadKey, weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  });
});

test("intentFromXdr decodes a set_options op with no signer field as signer: null", () => {
  const txXdr = txWith(
    Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "set_options",
    signer: null,
    masterWeight: null,
    lowThreshold: 0,
    medThreshold: 1,
    highThreshold: 1,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
  });
});

test("intentFromXdr decodes a set_options op's flags, home domain, and inflation destination", () => {
  const inflationTarget = Keypair.random().publicKey();
  const xdr = txWith(
    Operation.setOptions({
      homeDomain: "example.com",
      setFlags: 1,
      clearFlags: 2,
      inflationDest: inflationTarget,
    })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    source: SRC,
    type: "set_options",
    signer: null,
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: "example.com",
    setFlags: 1,
    clearFlags: 2,
    inflationDest: inflationTarget,
  });
});

// ─── Soroban contract invocations (DeFi exits) ───────────────────────────────

test("intentFromXdr describes a contract invocation: contract, function, rendered args, and every account named", () => {
  const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
  const OTHER = Keypair.random().publicKey();
  const op = Operation.invokeContractFunction({
    contract: POOL,
    function: "submit",
    args: [
      new Address(SRC).toScVal(),
      new Address(SRC).toScVal(),
      // A recipient buried inside a vector of structs is still found.
      xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("to"), val: new Address(OTHER).toScVal() }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("amount"),
            val: nativeToScVal(5n, { type: "i128" }),
          }),
        ]),
      ]),
    ],
  });
  const intent = intentFromXdr(txWith(op as never), Networks.TESTNET);
  const [described] = intent.operations;
  expect(described).toMatchObject({
    source: SRC,
    type: "invoke_host_function",
    contract: POOL,
    function: "submit",
    accountsReferenced: [SRC, OTHER].sort(),
    contractsReferenced: [],
    unsupportedAddressCount: 0,
    authorizesBeyondSelf: false,
  });
  if (described!.type !== "invoke_host_function") throw new Error("expected an invocation");
  expect(described.args).toHaveLength(3);
  expect(described.args[0]).toBe(SRC);
  expect(described.args[2]).toContain('"amount":"5"');
  // An invocation moves no classic funds, so the classic guarantees stay empty.
  expect(intent.guarantees.paymentsOnlyTo).toEqual([]);
  expect(intent.guarantees.mergeDestination).toBeNull();
});

const SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function contractCall(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subs: xdr.SorobanAuthorizedInvocation[] = []
) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    subInvocations: subs,
  });
}

test("intentFromXdr walks the authorization tree - a recipient hidden in a nested transfer is found", () => {
  const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
  const OTHER = Keypair.random().publicKey();
  // The visible arguments name only the source; the signature would also authorize the pool to
  // move the source's tokens to OTHER, which only the auth entry spells out.
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: contractCall(
      POOL,
      "submit",
      [new Address(SRC).toScVal()],
      [
        contractCall(SAC, "transfer", [
          new Address(SRC).toScVal(),
          new Address(OTHER).toScVal(),
          nativeToScVal(5n, { type: "i128" }),
        ]),
      ]
    ),
  });
  const op = Operation.invokeContractFunction({
    contract: POOL,
    function: "submit",
    args: [new Address(SRC).toScVal()],
    auth: [auth],
  });
  const intent = intentFromXdr(txWith(op as never), Networks.TESTNET);
  expect(intent.operations[0]).toMatchObject({
    type: "invoke_host_function",
    accountsReferenced: [SRC, OTHER].sort(),
    contractsReferenced: [POOL, SAC].sort(),
    unsupportedAddressCount: 0,
    authorizesBeyondSelf: false,
  });
});

test("intentFromXdr flags credentials for another address and a non-contract authorized function", () => {
  const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
  const other = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(Keypair.random().publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: contractCall(POOL, "submit", []),
  });
  const op = Operation.invokeContractFunction({
    contract: POOL,
    function: "submit",
    args: [],
    auth: [other],
  });
  const intent = intentFromXdr(txWith(op as never), Networks.TESTNET);
  expect(intent.operations[0]).toMatchObject({ authorizesBeyondSelf: true });
});

test("intentFromXdr counts a muxed account, a claimable balance, or a pool address as unverifiable rather than skipping it", () => {
  const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
  const muxed = xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeMuxedAccount(
      new xdr.MuxedEd25519Account({
        id: xdr.Uint64.fromString("7"),
        ed25519: StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()),
      })
    )
  );
  const op = Operation.invokeContractFunction({
    contract: POOL,
    function: "submit",
    args: [new Address(SRC).toScVal(), muxed],
  });
  const intent = intentFromXdr(txWith(op as never), Networks.TESTNET);
  expect(intent.operations[0]).toMatchObject({
    accountsReferenced: [SRC],
    unsupportedAddressCount: 1,
  });
});
