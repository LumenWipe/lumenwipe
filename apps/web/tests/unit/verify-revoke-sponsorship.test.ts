import { describe, expect, test } from "bun:test";
import {
  Account,
  Asset,
  hash,
  Keypair,
  LiquidityPoolId,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { assertCloseIntent, VerificationError, type CloseExpectation } from "@/lib/stellar/verify";
import type { SponsoredEntry } from "@/types/account";
import type { IntentOperation } from "@/types/close-api";

const SOURCE_KP = Keypair.random();
const OWNER_KP = Keypair.random();
const DEST_KP = Keypair.random();
const ISSUER = Keypair.random().publicKey();

function baseExpected(): CloseExpectation {
  return {
    source: SOURCE_KP.publicKey(),
    destination: DEST_KP.publicKey(),
    mediatorRequired: false,
    directMergeRefused: false,
    nativeBalance: "100.0000000",
    memo: null,
    memoRequired: false,
    memoType: null,
    claimTrustlineAssets: [],
    transfers: {},
    tokenTransfers: {},
    depositAddresses: {},
    classicConversions: {},
    tokenConversions: {},
    conversionContracts: [],
    xlmContract: Asset.native().contractId(Networks.TESTNET),
    exitContracts: [],
    heldTokenContracts: [],
    positionTokenContracts: [],
    exitFunctions: {},
    accountSigners: [],
    accountThresholds: { low: 0, med: 1, high: 1 },
    nowSeconds: Math.floor(Date.now() / 1000),
    registryContracts: [],
    protectedTokenContracts: [],
    xbullAssets: {},
    ownTokensByContract: {},
    shareTokenContracts: [],
    debtTokenContracts: [],
    repayTokensByPool: {},
    sponsoredEntries: [{ kind: "account", owner: OWNER_KP.publicKey() }],
  };
}

function sourceAccount(): Account {
  return new Account(SOURCE_KP.publicKey(), "1");
}

const OWNER = OWNER_KP.publicKey();
const OTHER = Keypair.random().publicKey();
const POOL_ID = "ab".repeat(32);
const PRE_AUTH = hash(Buffer.from("pre-auth signer"));
const HASH_X = hash(Buffer.from("hash-x signer"));
const SIGNER_G = Keypair.random().publicKey();
const SIGNER_P = StrKey.encodeSignedPayload(
  new xdr.SignerKeyEd25519SignedPayload({
    ed25519: Keypair.random().rawPublicKey(),
    payload: Buffer.from("payload"),
  }).toXDR()
);

type Fixture = {
  entry: (owner: string) => SponsoredEntry;
  op: (owner: string) => xdr.Operation;
  key: Omit<Extract<IntentOperation, { type: "revoke_sponsorship" }>, "type" | "owner" | "source">;
};

const KINDS: Record<string, Fixture> = {
  account: {
    entry: (owner) => ({ kind: "account", owner }),
    op: (owner) => Operation.revokeAccountSponsorship({ account: owner }),
    key: { entryKind: "account" },
  },
  trustline: {
    entry: (owner) => ({ kind: "trustline", owner, asset: `USDC:${ISSUER}` }),
    op: (owner) =>
      Operation.revokeTrustlineSponsorship({ account: owner, asset: new Asset("USDC", ISSUER) }),
    key: { entryKind: "trustline", asset: `USDC:${ISSUER}` },
  },
  pool_share_trustline: {
    entry: (owner) => ({ kind: "pool_share_trustline", owner, poolId: POOL_ID }),
    op: (owner) =>
      Operation.revokeTrustlineSponsorship({ account: owner, asset: new LiquidityPoolId(POOL_ID) }),
    key: { entryKind: "trustline", poolId: POOL_ID },
  },
  offer: {
    entry: (owner) => ({ kind: "offer", owner, offerId: "4815162342" }),
    op: (owner) => Operation.revokeOfferSponsorship({ seller: owner, offerId: "4815162342" }),
    key: { entryKind: "offer", offerId: "4815162342" },
  },
  data_entry: {
    entry: (owner) => ({ kind: "data_entry", owner, name: "config" }),
    op: (owner) => Operation.revokeDataSponsorship({ account: owner, name: "config" }),
    key: { entryKind: "data_entry", name: "config" },
  },
  ed25519_signer: {
    entry: (owner) => ({ kind: "signer", owner, signerKey: SIGNER_G }),
    op: (owner) =>
      Operation.revokeSignerSponsorship({ account: owner, signer: { ed25519PublicKey: SIGNER_G } }),
    key: { entryKind: "signer", signerKey: SIGNER_G },
  },
  pre_auth_signer: {
    entry: (owner) => ({ kind: "signer", owner, signerKey: StrKey.encodePreAuthTx(PRE_AUTH) }),
    op: (owner) =>
      Operation.revokeSignerSponsorship({ account: owner, signer: { preAuthTx: PRE_AUTH } }),
    key: { entryKind: "signer", signerKey: StrKey.encodePreAuthTx(PRE_AUTH) },
  },
  hash_x_signer: {
    entry: (owner) => ({ kind: "signer", owner, signerKey: StrKey.encodeSha256Hash(HASH_X) }),
    op: (owner) =>
      Operation.revokeSignerSponsorship({ account: owner, signer: { sha256Hash: HASH_X } }),
    key: { entryKind: "signer", signerKey: StrKey.encodeSha256Hash(HASH_X) },
  },
  signed_payload_signer: {
    entry: (owner) => ({ kind: "signer", owner, signerKey: SIGNER_P }),
    op: (owner) =>
      Operation.revokeSignerSponsorship({
        account: owner,
        signer: { ed25519SignedPayload: SIGNER_P },
      }),
    key: { entryKind: "signer", signerKey: SIGNER_P },
  },
};

function intentOf(ops: xdr.Operation[]) {
  const builder = new TransactionBuilder(sourceAccount(), {
    fee: String(100 * (ops.length + 1)),
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) builder.addOperation(op);
  builder.addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }));
  return intentFromXdr(builder.setTimeout(60).build().toXDR(), Networks.TESTNET);
}

function check(ops: xdr.Operation[], sponsoredEntries?: SponsoredEntry[]): void {
  const expected = { ...baseExpected(), sponsoredEntries };
  assertCloseIntent(intentOf(ops), expected);
}

function refusal(run: () => void): string | null {
  try {
    run();
  } catch (err) {
    if (err instanceof VerificationError) return err.code;
    throw err;
  }
  return null;
}

describe.each(Object.entries(KINDS))("verify › a %s sponsorship revoke", (_, fixture) => {
  test("carries the key its operation names", () => {
    expect(intentOf([fixture.op(OWNER)]).operations[0]).toEqual({
      source: SOURCE_KP.publicKey(),
      type: "revoke_sponsorship",
      owner: OWNER,
      ...fixture.key,
    });
  });

  test("is accepted for an entry the account read lists", () => {
    expect(refusal(() => check([fixture.op(OWNER)], [fixture.entry(OWNER)]))).toBeNull();
  });

  test("is refused for an entry the account read does not list", () => {
    expect(refusal(() => check([fixture.op(OWNER)], []))).toBe("sponsorship_revoke_unknown");
  });

  test("is refused for the same entry on another account", () => {
    expect(refusal(() => check([fixture.op(OTHER)], [fixture.entry(OWNER)]))).toBe(
      "sponsorship_revoke_unknown"
    );
  });

  test("is refused when it names the same entry twice", () => {
    expect(
      refusal(() => check([fixture.op(OWNER), fixture.op(OWNER)], [fixture.entry(OWNER)]))
    ).toBe("sponsorship_revoke_duplicate");
  });

  test("is refused without the account read's sponsored entries", () => {
    expect(refusal(() => check([fixture.op(OWNER)]))).toBe("sponsorship_revoke_unknown");
  });
});

test("verify › one revoke of every listed entry is accepted together", () => {
  const fixtures = Object.values(KINDS);
  expect(
    refusal(() =>
      check(
        fixtures.map((f) => f.op(OWNER)),
        fixtures.map((f) => f.entry(OWNER))
      )
    )
  ).toBeNull();
});

test("verify › a listed key of another kind does not admit a revoke", () => {
  const asData: SponsoredEntry = { kind: "data_entry", owner: OWNER, name: `USDC:${ISSUER}` };
  expect(refusal(() => check([KINDS.trustline.op(OWNER)], [asData]))).toBe(
    "sponsorship_revoke_unknown"
  );
  const asLine: SponsoredEntry = { kind: "trustline", owner: OWNER, asset: POOL_ID };
  expect(refusal(() => check([KINDS.pool_share_trustline.op(OWNER)], [asLine]))).toBe(
    "sponsorship_revoke_unknown"
  );
});

test("verify › a listed claimable balance admits no revoke", () => {
  const balance: SponsoredEntry = { kind: "claimable_balance", balanceId: "00".repeat(36) };
  expect(refusal(() => check([KINDS.account.op(OWNER)], [balance]))).toBe(
    "sponsorship_revoke_unknown"
  );
});

test("verify › a data name that is not valid UTF-8 names no entry and is refused", () => {
  // stellar-core only admits printable ASCII in a data name, so no listed entry can have one.
  const key = xdr.LedgerKey.data(
    new xdr.LedgerKeyData({
      accountId: Keypair.fromPublicKey(OWNER).xdrAccountId(),
      dataName: Buffer.from([0x61, 0xff, 0x62]) as unknown as string,
    })
  );
  const op = new xdr.Operation({
    sourceAccount: null,
    body: xdr.OperationBody.revokeSponsorship(
      xdr.RevokeSponsorshipOp.revokeSponsorshipLedgerEntry(key)
    ),
  });
  expect(intentOf([op]).operations[0]).toEqual({
    source: SOURCE_KP.publicKey(),
    type: "revoke_sponsorship",
    entryKind: "data_entry",
    owner: OWNER,
  });
  const lossy: SponsoredEntry = { kind: "data_entry", owner: OWNER, name: "a\uFFFDb" };
  expect(refusal(() => check([op], [lossy]))).toBe("sponsorship_revoke_unknown");
});

test("verify › a liquidity pool entry's sponsorship revoke stays unrecognized", () => {
  const intent = intentOf([Operation.revokeLiquidityPoolSponsorship({ liquidityPoolId: POOL_ID })]);
  expect(intent.operations[0]).toEqual({ source: SOURCE_KP.publicKey(), type: "unknown" });
});

test("verify › a revoke op wrapped in a sponsorship-transfer bracket is rejected (the actual redirect attack)", () => {
  // CAP-33's only reserve-redirecting transition: the revoke op's source account (the account
  // being closed) is itself sponsored by a third party for the duration of the bracket, so the
  // revoked entry's reserve moves to that third party instead of reverting to its owner.
  const attackerKp = Keypair.random();
  const tx = new TransactionBuilder(sourceAccount(), {
    fee: "400",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: SOURCE_KP.publicKey(),
        source: attackerKp.publicKey(),
      })
    )
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: SOURCE_KP.publicKey() }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXdr("base64"), Networks.TESTNET);
  // The bracket ops must stay unrecognized - that, and only that, is what rejects the attack.
  // Their sources differ (the sponsor opens the bracket, the sponsored account closes it),
  // which is exactly why operations carry the account they act as rather than inheriting the
  // transaction's.
  expect(intent.operations[0]).toEqual({ source: attackerKp.publicKey(), type: "unknown" });
  expect(intent.operations[2]).toEqual({ source: SOURCE_KP.publicKey(), type: "unknown" });
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(VerificationError);
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(/unrecognized operation/);
});

test("verify › a sponsorship bracket is rejected wherever it sits in the operation list", () => {
  // Position-independence: assertCloseIntent scans every operation, so a bracket placed after
  // an otherwise-valid close (or split around it) is rejected just the same.
  const attackerKp = Keypair.random();
  const tx = new TransactionBuilder(sourceAccount(), {
    fee: "400",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: SOURCE_KP.publicKey(),
        source: attackerKp.publicKey(),
      })
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: SOURCE_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXdr("base64"), Networks.TESTNET);
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(/unrecognized operation/);
});

test("verify › the reverse bracket orientation (closing account becomes the new sponsor) is rejected", () => {
  // The mirror image of the attack above: instead of a third party taking over the reserve,
  // the CLOSING account is made the new sponsor of someone else's entry, locking its own XLM
  // into a sponsorship it never agreed to. Rejection keys on the bracket op TYPE, not on the
  // direction of the transfer, so the same `unknown` branch catches both orientations.
  const otherKp = Keypair.random();
  const tx = new TransactionBuilder(sourceAccount(), {
    fee: "400",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: otherKp.publicKey(),
        source: SOURCE_KP.publicKey(),
      })
    )
    .addOperation(
      Operation.revokeAccountSponsorship({
        account: OWNER_KP.publicKey(),
        source: otherKp.publicKey(),
      })
    )
    .addOperation(Operation.endSponsoringFutureReserves({ source: otherKp.publicKey() }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXdr("base64"), Networks.TESTNET);
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(/unrecognized operation/);
});

test("verify › revokeClaimableBalanceSponsorship stays unrecognized and is rejected", () => {
  // Deliberately absent from normalizeOp's case list: CAP-33 requires a cooperating new sponsor
  // to revoke a claimable balance's sponsorship, which this self-service close flow can never
  // arrange, so the API builder skips such entries entirely (they stay a blocker). If the API
  // ever emits one anyway, the anchor must fail closed rather than wave it through.
  const balanceId = `00000000${"ab".repeat(32)}`.slice(0, 72);
  const tx = new TransactionBuilder(sourceAccount(), {
    fee: "200",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.revokeClaimableBalanceSponsorship({ balanceId }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXdr("base64"), Networks.TESTNET);
  expect(intent.operations[0]).toEqual({ source: SOURCE_KP.publicKey(), type: "unknown" });
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(/unrecognized operation/);
});
