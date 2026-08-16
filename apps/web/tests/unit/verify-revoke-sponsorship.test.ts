import { test, expect } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { assertCloseIntent, VerificationError, type CloseExpectation } from "@/lib/stellar/verify";

const SOURCE_KP = Keypair.random();
const OWNER_KP = Keypair.random();
const DEST_KP = Keypair.random();
const ISSUER = Keypair.random().publicKey();

function baseExpected(): CloseExpectation {
  return {
    source: SOURCE_KP.publicKey(),
    destination: DEST_KP.publicKey(),
    memo: null,
    memoRequired: false,
    memoType: null,
    claimTrustlineAssets: [],
    accountSigners: [],
    accountThresholds: { low: 0, med: 1, high: 1 },
  };
}

function sourceAccount(): Account {
  return new Account(SOURCE_KP.publicKey(), "1");
}

test("verify › a plain revoke-account-sponsorship op is accepted", () => {
  const tx = new TransactionBuilder(sourceAccount(), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
  expect(intent.operations[0]).toEqual({
    source: SOURCE_KP.publicKey(),
    type: "revoke_sponsorship",
    entryKind: "account",
    owner: OWNER_KP.publicKey(),
  });
  expect(() => assertCloseIntent(intent, baseExpected())).not.toThrow();
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
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
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
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
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
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
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
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
  expect(intent.operations[0]).toEqual({ source: SOURCE_KP.publicKey(), type: "unknown" });
  expect(() => assertCloseIntent(intent, baseExpected())).toThrow(/unrecognized operation/);
});

test("verify › every revoke-sponsorship op kind is recognized and accepted", () => {
  const tx = new TransactionBuilder(sourceAccount(), {
    fee: "600",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.revokeAccountSponsorship({ account: OWNER_KP.publicKey() }))
    .addOperation(
      Operation.revokeTrustlineSponsorship({
        account: OWNER_KP.publicKey(),
        asset: new Asset("USDC", ISSUER),
      })
    )
    .addOperation(Operation.revokeOfferSponsorship({ seller: OWNER_KP.publicKey(), offerId: "1" }))
    .addOperation(Operation.revokeDataSponsorship({ account: OWNER_KP.publicKey(), name: "foo" }))
    .addOperation(
      Operation.revokeSignerSponsorship({
        account: OWNER_KP.publicKey(),
        signer: { ed25519PublicKey: Keypair.random().publicKey() },
      })
    )
    .addOperation(Operation.accountMerge({ destination: DEST_KP.publicKey() }))
    .setTimeout(60)
    .build();
  const intent = intentFromXdr(tx.toEnvelope().toXDR("base64"), Networks.TESTNET);
  expect(intent.operations.slice(0, 5).map((o) => o.type)).toEqual([
    "revoke_sponsorship",
    "revoke_sponsorship",
    "revoke_sponsorship",
    "revoke_sponsorship",
    "revoke_sponsorship",
  ]);
  expect(intent.operations.slice(0, 5)).toEqual([
    { source: SOURCE_KP.publicKey(), type: "revoke_sponsorship", entryKind: "account", owner: OWNER_KP.publicKey() },
    { source: SOURCE_KP.publicKey(), type: "revoke_sponsorship", entryKind: "trustline", owner: OWNER_KP.publicKey() },
    { source: SOURCE_KP.publicKey(), type: "revoke_sponsorship", entryKind: "offer", owner: OWNER_KP.publicKey() },
    { source: SOURCE_KP.publicKey(), type: "revoke_sponsorship", entryKind: "data_entry", owner: OWNER_KP.publicKey() },
    { source: SOURCE_KP.publicKey(), type: "revoke_sponsorship", entryKind: "signer", owner: OWNER_KP.publicKey() },
  ]);
  expect(() => assertCloseIntent(intent, baseExpected())).not.toThrow();
});
