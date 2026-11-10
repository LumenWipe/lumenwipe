import { describe, expect, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { MAX_SPONSORED_FEE_STROOPS } from "@/lib/fee-policy";
import type { ScenarioSelection } from "@/lib/scenarios";
import {
  expectationFromSession,
  PlaygroundVerificationError,
  verifyDemolishTransaction,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";
import { assertSponsoredEnvelope, parseExpectedFeeAccount } from "@/lib/verify-feebump";

// The sponsored close's two checks: the inner transaction is held to every rule a close is held
// to, and may leave its own fee at zero only in a session that selected the sponsored fee with a
// fee account configured; the sponsor's envelope is held to that fee account, the approved
// transaction, its signatures and the API's own ceiling. Every key is generated per run.

const PASSPHRASE = Networks.TESTNET;
const demo = Keypair.random();
const sink = Keypair.random().publicKey();
const issuer = Keypair.random().publicKey();
const feeAccount = Keypair.random();
const stranger = Keypair.random();

const SPONSORED: ScenarioSelection = {
  scenarios: [
    { id: "data-entries", params: { count: 1 } },
    { id: "fee-bump", params: {} },
  ],
};
const UNSPONSORED: ScenarioSelection = {
  scenarios: [{ id: "data-entries", params: { count: 1 } }],
};

function expectation(
  selection: ScenarioSelection,
  configured: string | null
): PlaygroundCloseExpectation {
  return expectationFromSession(
    {
      demoPublic: demo.publicKey(),
      ephemeralIssuers: [],
      recordedSigners: [],
      selection,
      transferRecipient: null,
      helperAccounts: [],
      claimableBalances: [],
    },
    sink,
    issuer,
    configured
  );
}

/** The close the API builds for the session: the data entry's removal, then the merge. */
function closeXdr(fee: string, destination = sink): string {
  return new TransactionBuilder(new Account(demo.publicKey(), "1"), {
    fee,
    networkPassphrase: PASSPHRASE,
  })
    .setTimebounds(0, Math.floor(Date.now() / 1000) + 300)
    .addOperation(Operation.manageData({ name: "promo_code", value: null }))
    .addOperation(Operation.accountMerge({ destination }))
    .build()
    .toEnvelope()
    .toXdr("base64");
}

function closeTx(xdr: string): CloseTransaction {
  return {
    id: "close-1",
    order: 0,
    dependsOn: [],
    xdr,
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: ["REMOVE_DATA_ENTRIES", "MERGE"],
    intent: {
      summary: "Remove 1 data entry and close the account",
      source: demo.publicKey(),
      fee: "0",
      memo: null,
      memoType: null,
      guarantees: { mergeDestination: sink, paymentsOnlyTo: [], minXlmFromConversions: null },
      operations: [],
    },
  };
}

function codeOf(fn: () => void): string {
  try {
    fn();
    return "accepted";
  } catch (err) {
    if (err instanceof PlaygroundVerificationError) return err.message;
    if (err instanceof Error && "code" in err) return String((err as { code: unknown }).code);
    throw err;
  }
}

describe("a close's own fee of zero", () => {
  const verify = (xdr: string, expected: PlaygroundCloseExpectation): string =>
    codeOf(() => verifyDemolishTransaction(closeTx(xdr), expected));

  test("is accepted only in a session that selected the sponsored fee, with a fee account", () => {
    expect(verify(closeXdr("0"), expectation(SPONSORED, feeAccount.publicKey()))).toBe("accepted");
    expect(verify(closeXdr("0"), expectation(UNSPONSORED, feeAccount.publicKey()))).toBe(
      "zero_fee_not_sponsored"
    );
    expect(verify(closeXdr("0"), expectation(SPONSORED, null))).toBe("zero_fee_not_sponsored");
  });

  test("a fee the demo pays is accepted either way", () => {
    for (const expected of [
      expectation(SPONSORED, feeAccount.publicKey()),
      expectation(UNSPONSORED, null),
    ]) {
      expect(verify(closeXdr("100"), expected)).toBe("accepted");
    }
  });

  test("the configured fee account is kept only for a session that selected the sponsored fee", () => {
    expect(expectation(SPONSORED, feeAccount.publicKey()).sponsorFeeAccount).toBe(
      feeAccount.publicKey()
    );
    expect(expectation(UNSPONSORED, feeAccount.publicKey()).sponsorFeeAccount).toBeNull();
  });

  test("an inner transaction that breaks a normal rule is refused, sponsored or not", () => {
    const elsewhere = closeXdr("0", stranger.publicKey());
    const sponsored = verify(elsewhere, expectation(SPONSORED, feeAccount.publicKey()));
    expect(sponsored).not.toBe("accepted");
    expect(sponsored).toBe(
      verify(closeXdr("100", stranger.publicKey()), expectation(SPONSORED, null))
    );
  });

  test("a fee-bump envelope from the API is refused outright", () => {
    const inner = TransactionBuilder.fromXdr(closeXdr("0"), PASSPHRASE) as Transaction;
    const wrapped = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      "100",
      inner,
      PASSPHRASE
    );
    wrapped.sign(feeAccount);
    expect(
      verify(wrapped.toEnvelope().toXdr("base64"), expectation(SPONSORED, feeAccount.publicKey()))
    ).toBe("fee_bump_not_allowed");
  });
});

/** The playground's signed close, as it goes to the sponsor. */
function signedClose(): { xdr: string; tx: Transaction; hash: string } {
  const tx = TransactionBuilder.fromXdr(closeXdr("0"), PASSPHRASE) as Transaction;
  tx.sign(demo);
  return { xdr: tx.toEnvelope().toXdr("base64"), tx, hash: Buffer.from(tx.hash()).toString("hex") };
}

/** A fee-bump envelope around `inner`, paid by `source` at `baseFee` per operation. */
function sponsor(
  inner: Transaction,
  { source = feeAccount.publicKey(), baseFee = "100", signers = [feeAccount] } = {}
): string {
  const wrapped = TransactionBuilder.buildFeeBumpTransaction(source, baseFee, inner, PASSPHRASE);
  for (const signer of signers) wrapped.sign(signer);
  return wrapped.toEnvelope().toXdr("base64");
}

describe("the sponsor's envelope", () => {
  const signed = signedClose();
  const expected = {
    feeAccount: feeAccount.publicKey(),
    approvedHash: signed.hash,
    signatureCount: 1,
  };
  const check = (envelope: string): string =>
    codeOf(() => assertSponsoredEnvelope(envelope, expected));

  test("around the approved transaction, paid and signed by the fee account, is accepted", () => {
    expect(check(sponsor(signed.tx))).toBe("accepted");
  });

  test("a fee source other than the configured one is refused, even signed by itself", () => {
    expect(check(sponsor(signed.tx, { source: stranger.publicKey(), signers: [stranger] }))).toBe(
      "sponsored_fee_source_unexpected"
    );
    expect(
      check(sponsor(signed.tx, { source: stranger.publicKey(), signers: [stranger, feeAccount] }))
    ).toBe("sponsored_fee_source_unexpected");
  });

  test("an outer fee above the API sponsor's own cap is refused", () => {
    // Two operations inside and the fee-bump itself: three times the base fee per operation.
    const ops = BigInt(3);
    const atCeiling = MAX_SPONSORED_FEE_STROOPS / ops;
    expect(atCeiling * ops).toBe(MAX_SPONSORED_FEE_STROOPS - BigInt(2));
    expect(check(sponsor(signed.tx, { baseFee: atCeiling.toString() }))).toBe("accepted");
    const over = sponsor(signed.tx, { baseFee: (atCeiling + BigInt(1)).toString() });
    expect(BigInt(TransactionBuilder.fromXdr(over, PASSPHRASE).fee)).toBeGreaterThan(
      MAX_SPONSORED_FEE_STROOPS
    );
    expect(check(over)).toBe("sponsored_fee_above_ceiling");
  });

  test("a fee exactly at the ceiling is accepted", () => {
    // One operation inside: the outer fee is twice the base fee, which divides the ceiling exactly.
    const single = new TransactionBuilder(new Account(demo.publicKey(), "1"), {
      fee: "0",
      networkPassphrase: PASSPHRASE,
    })
      .setTimebounds(0, Math.floor(Date.now() / 1000) + 300)
      .addOperation(Operation.accountMerge({ destination: sink }))
      .build();
    single.sign(demo);
    const base = (MAX_SPONSORED_FEE_STROOPS / BigInt(2)).toString();
    const envelope = sponsor(single, { baseFee: base });
    expect(BigInt(TransactionBuilder.fromXdr(envelope, PASSPHRASE).fee)).toBe(
      MAX_SPONSORED_FEE_STROOPS
    );
    expect(
      codeOf(() =>
        assertSponsoredEnvelope(envelope, {
          ...expected,
          approvedHash: Buffer.from(single.hash()).toString("hex"),
        })
      )
    ).toBe("accepted");
    const above = sponsor(single, { baseFee: (BigInt(base) + BigInt(1)).toString() });
    expect(
      codeOf(() =>
        assertSponsoredEnvelope(above, {
          ...expected,
          approvedHash: Buffer.from(single.hash()).toString("hex"),
        })
      )
    ).toBe("sponsored_fee_above_ceiling");
  });

  test("an inner transaction other than the approved one is refused", () => {
    const other = TransactionBuilder.fromXdr(closeXdr("0", stranger.publicKey()), PASSPHRASE);
    if (!(other instanceof Transaction)) throw new Error("expected a transaction");
    other.sign(demo);
    expect(check(sponsor(other))).toBe("sponsored_inner_not_approved");
  });

  test("a signature dropped from the approved transaction is refused", () => {
    const unsigned = TransactionBuilder.fromXdr(closeXdr("0"), PASSPHRASE) as Transaction;
    expect(Buffer.from(unsigned.hash()).toString("hex")).toBe(signed.hash);
    expect(check(sponsor(unsigned))).toBe("sponsored_signature_dropped");
  });

  test("an outer envelope the fee account did not sign is refused", () => {
    expect(check(sponsor(signed.tx, { signers: [] }))).toBe("sponsored_envelope_unsigned");
    expect(check(sponsor(signed.tx, { signers: [stranger] }))).toBe("sponsored_envelope_unsigned");
    expect(check(sponsor(signed.tx, { signers: [demo] }))).toBe("sponsored_envelope_unsigned");
  });

  test("anything but a fee-bump envelope is refused", () => {
    expect(check(signed.xdr)).toBe("sponsored_envelope_not_fee_bump");
    expect(check("not a transaction")).toBe("sponsored_envelope_unreadable");
  });
});

test("the configured fee account must be an account public key", () => {
  const kp = Keypair.random();
  expect(parseExpectedFeeAccount(kp.publicKey())).toBe(kp.publicKey());
  expect(parseExpectedFeeAccount(`\n${kp.publicKey()} `)).toBe(kp.publicKey());
  for (const raw of [undefined, "", kp.secret(), kp.publicKey().toLowerCase()]) {
    expect(parseExpectedFeeAccount(raw)).toBeNull();
  }
});
