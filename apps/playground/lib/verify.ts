import "server-only";
import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  exitExpectations,
  verifyCloseTransaction,
  type CloseExpectationInput,
  type TransferChoice,
} from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { LWDEMO_CODE } from "./mess-plan";
import type { PlaygroundSession } from "./session-store";

// The check the playground's backend runs on every XDR the real API returns, before signing it.
//
// The rules are not restated here. Every transaction goes through `@lumenwipe/verify`, the
// verifier compiled from the web app's own trust anchor (apps/web/lib/stellar/verify.ts), so the
// playground cannot drift from production: there is one allowlist and one set of operation rules.
// What makes it narrower is what it is told to expect, all of it taken from the session record and
// the playground's own configuration, never from the API's response:
//
// - the merge goes to the fixed sink, with no memo;
// - a payment may only return an asset of the session to its own issuer;
// - a signer may only be removed if the session recorded adding it;
// - no transfer, conversion, claim or DeFi exit was chosen, so each of those is refused.
//
// On top of that, two rules the shared verifier cannot hold for every close, because the
// exchange hand-off places its forward payment after the merge and a large close spans several
// transactions: a playground close is one transaction that ends in its merge, with no more
// operations than the session's own entries can explain. The demolish runs one round per request
// (lib/demolish.ts), and no session needs a second: the master key alone can sign, so the API adds
// no signer-normalization round, and the session's entries stay far below one transaction's
// operation limit. A round that is not the final merge is therefore refused before it is signed.

export class PlaygroundVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundVerificationError";
  }
}

/** One asset the session can hold: its code and the issuer it returns to. */
export interface SessionAsset {
  code: string;
  issuer: string;
}

/** What a demolish of one session may do, from the session record and the playground config. */
export interface PlaygroundCloseExpectation {
  demoPublic: string;
  sinkPublic: string;
  assets: SessionAsset[];
  recordedSigners: string[];
  offerCount: number;
  dataEntryCount: number;
}

/**
 * The expectation for a session's demolish. `lwdemoIssuer` is the playground's persistent issuer
 * from its configuration; every other asset is one of the session's ephemeral issuers.
 */
export function expectationFromSession(
  session: Pick<
    PlaygroundSession,
    "demoPublic" | "ephemeralIssuers" | "recordedSigners" | "offerCount" | "dataEntryCount"
  >,
  sinkPublic: string,
  lwdemoIssuer: string
): PlaygroundCloseExpectation {
  return {
    demoPublic: session.demoPublic,
    sinkPublic,
    assets: [
      { code: LWDEMO_CODE, issuer: lwdemoIssuer },
      ...session.ephemeralIssuers.map((e) => ({ code: e.assetCode, issuer: e.publicKey })),
    ],
    recordedSigners: [...session.recordedSigners],
    offerCount: session.offerCount,
    dataEntryCount: session.dataEntryCount,
  };
}

/**
 * The most operations a session's close can need: a return payment and a trustline removal per
 * asset, one cancellation per offer, one removal per data entry and per recorded signer, the
 * threshold reset that follows signer removal, and the merge.
 */
export function maxOperations(expected: PlaygroundCloseExpectation): number {
  return (
    2 * expected.assets.length +
    expected.offerCount +
    expected.dataEntryCount +
    expected.recordedSigners.length +
    2
  );
}

function sharedExpectation(expected: PlaygroundCloseExpectation): CloseExpectationInput {
  const transfers: Record<string, TransferChoice> = {};
  for (const { code, issuer } of expected.assets) {
    // A return to the issuer, as the web app expresses one: the destination is pinned to the
    // issuer encoded in the asset itself, so the amount is no floor at all.
    transfers[`${code}:${issuer}`] = { destination: issuer, amount: "0" };
  }
  return {
    ...exitExpectations(null, "testnet"),
    source: expected.demoPublic,
    destination: expected.sinkPublic,
    // The sink is not an exchange, so the mediated hand-off this would floor is refused anyway.
    nativeBalance: "0",
    memo: null,
    memoType: null,
    claimTrustlineAssets: [],
    accountSigners: [expected.demoPublic, ...expected.recordedSigners].map((key) => ({
      key,
      weight: 1,
      type: "ed25519_public_key" as const,
    })),
    // The playground creates the demo account and never sets its thresholds.
    accountThresholds: { low: 0, med: 0, high: 0 },
    transfers,
    tokenTransfers: {},
    classicConversions: {},
    tokenConversions: {},
  };
}

export function verifyDemolishTransaction(
  tx: CloseTransaction,
  expected: PlaygroundCloseExpectation
): void {
  // A playground close is signed and paid for by the demo account itself; the API never wraps it.
  const parsed = TransactionBuilder.fromXdr(tx.xdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) {
    throw new PlaygroundVerificationError("fee_bump_not_allowed");
  }

  verifyCloseTransaction({
    unsignedXdr: tx.xdr,
    network: "testnet",
    expected: sharedExpectation(expected),
  });

  const ops = parsed.operations;
  if (ops.length > maxOperations(expected)) {
    throw new PlaygroundVerificationError("too_many_operations");
  }
  // The shared verifier already refuses a second merge; this pins the one merge to the end.
  if (ops.length === 0 || ops[ops.length - 1].type !== "accountMerge") {
    throw new PlaygroundVerificationError("merge_not_final");
  }
}
