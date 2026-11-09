import "server-only";
import { Asset, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  exitExpectations,
  verifyCloseTransaction,
  type CloseExpectationInput,
  type TransferChoice,
} from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import {
  conversionFloorStroops,
  isPersistentAsset,
  resolvePlan,
  type CloseOperationType,
} from "./scenarios";
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
// - a payment may only return an asset of the session to its own issuer, unless the session chose
//   another disposition for it: a transfer goes only to the session's own recipient, and an asset
//   chosen to convert can only be converted, to XLM, into the demo, for no less than the floor its
//   recorded amount and the playground's standing price give;
// - a signer may only be removed if the session recorded adding it;
// - a claim may only take a balance the session recorded creating for the demo, once, and a
//   trustline may only be added for the asset of such a balance, ahead of its claim;
// - a sponsorship may only be revoked on an entry the session recorded the demo sponsoring, and a
//   claimable balance's sponsorship never;
// - no DeFi exit was chosen, so each of those is refused.
//
// The shared verifier holds a transfer to a floor; the playground also holds a transfer and a
// conversion to at most the amount the mess paid in, so the two together pin a transfer exactly.
//
// On top of that, rules the shared verifier cannot hold for every close, because the exchange
// hand-off places its forward payment after the merge and a large close spans several
// transactions. The master key alone can sign, so the API adds no signer-normalization round, and
// the session's entries stay far below one transaction's operation limit, so a playground close is
// one transaction that ends in its merge, with no more operations than the session's entries can
// explain. The one exception is a session that recorded claimable balances for the demo: the API
// claims them in a transaction of its own first (one round per request, lib/demolish.ts), and that
// transaction may hold nothing but those claims and the trustlines they need. Any other round that
// is not the final merge is refused before it is signed.

export class PlaygroundVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundVerificationError";
  }
}

/**
 * The operation types a playground close may contain. Every scenario's close expectation lists
 * only these (tests/unit/scenario-registry.test.ts), and a transaction with any other is refused
 * here, whatever the shared verifier would allow for a production close.
 */
export const PLAYGROUND_CLOSE_OPERATION_TYPES: readonly CloseOperationType[] = [
  "accountMerge",
  "payment",
  "changeTrust",
  "manageData",
  "manageSellOffer",
  "setOptions",
  // A conversion the session chose; the shared verifier refuses one of any other asset.
  "pathPaymentStrictSend",
  // A claim of a balance the session recorded, in its own transaction.
  "claimClaimableBalance",
  // A revoke of an entry the session recorded the demo sponsoring.
  "revokeTrustlineSponsorship",
  "revokeDataSponsorship",
];

/** One asset the session can hold: its code and the issuer it returns to. */
export interface SessionAsset {
  code: string;
  issuer: string;
}

/** A balance the session chose to send to its own recipient, keyed by `CODE:ISSUER`. */
export interface PlaygroundTransfer {
  asset: string;
  destination: string;
  /** What the mess paid in: the transfer must move exactly this. */
  amount: string;
}

/** A balance the session chose to convert to XLM, keyed by `CODE:ISSUER`. */
export interface PlaygroundConversion {
  asset: string;
  /** What the mess paid in: the conversion may sell no more. */
  amount: string;
  /** The least XLM the conversion may accept, in stroops. */
  minAmountOut: string;
}

/** A balance the session recorded creating for the demo, which the close may claim once. */
export interface PlaygroundClaim {
  id: string;
  /** `CODE:ISSUER` or `native`. */
  asset: string;
  /** The demo holds no trustline for it, so the claim transaction adds one first. */
  addTrustline: boolean;
}

/** An entry of the beneficiary whose reserve the session recorded the demo paying. */
export type PlaygroundSponsoredEntry =
  | { kind: "trustline"; owner: string; asset: string }
  | { kind: "data_entry"; owner: string; name: string };

/** What a demolish of one session may do, from the session record and the playground config. */
export interface PlaygroundCloseExpectation {
  demoPublic: string;
  sinkPublic: string;
  assets: SessionAsset[];
  recordedSigners: string[];
  offerCount: number;
  dataEntryCount: number;
  transfers: PlaygroundTransfer[];
  conversions: PlaygroundConversion[];
  claims: PlaygroundClaim[];
  /** Balances the demo can claim only after the session, answered `forfeit`. */
  forfeits: string[];
  sponsoredEntries: PlaygroundSponsoredEntry[];
}

/**
 * The expectation for a session's demolish: the assets, offers, data entries and dispositions its
 * stored selection planned (lib/scenarios), the issuers and recipient it recorded, and the signers
 * it recorded. `persistentIssuer` is the playground's own issuer from its configuration (LWDEMO and
 * the disposition assets); every other asset must be one of the session's own ephemeral issuers.
 */
export function expectationFromSession(
  session: Pick<
    PlaygroundSession,
    | "demoPublic"
    | "ephemeralIssuers"
    | "recordedSigners"
    | "selection"
    | "transferRecipient"
    | "helperAccounts"
    | "claimableBalances"
  >,
  sinkPublic: string,
  persistentIssuer: string
): PlaygroundCloseExpectation {
  const planned = resolvePlan(session.selection).expectation;
  const issuerOf = (code: string): string => {
    if (isPersistentAsset(code)) return persistentIssuer;
    const issuer = session.ephemeralIssuers.find((e) => e.assetCode === code);
    if (!issuer) throw new PlaygroundVerificationError("session_issuer_missing");
    return issuer.publicKey;
  };
  // A balance claimed through a new trustline leaves its asset on the account, closed like any other.
  const assets = [...planned.assets, ...planned.arrivingAssets].map((code): SessionAsset => ({
    code,
    issuer: issuerOf(code),
  }));
  const claims = session.claimableBalances.flatMap((b): PlaygroundClaim[] =>
    b.intent === "claim" || b.intent === "add_trustline_then_claim"
      ? [{ id: b.id, asset: b.asset, addTrustline: b.intent === "add_trustline_then_claim" }]
      : []
  );
  const forfeits = session.claimableBalances.filter((b) => b.intent === "forfeit").map((b) => b.id);
  const beneficiary = session.helperAccounts.find((h) => h.role === "beneficiary");
  const sponsoredEntries = planned.sponsoredEntries.map((entry): PlaygroundSponsoredEntry => {
    if (!beneficiary) throw new PlaygroundVerificationError("session_beneficiary_missing");
    const owner = beneficiary.publicKey;
    return entry.kind === "trustline"
      ? { kind: "trustline", owner, asset: `${entry.asset}:${issuerOf(entry.asset)}` }
      : { kind: "data_entry", owner, name: entry.name };
  });
  const transfers: PlaygroundTransfer[] = [];
  const conversions: PlaygroundConversion[] = [];
  for (const { asset: code, choice, amount } of planned.dispositions) {
    const asset = `${code}:${issuerOf(code)}`;
    if (choice === "convert") {
      conversions.push({ asset, amount, minAmountOut: conversionFloorStroops(amount).toString() });
    } else if (choice === "transfer") {
      if (!session.transferRecipient) {
        throw new PlaygroundVerificationError("session_recipient_missing");
      }
      transfers.push({ asset, destination: session.transferRecipient.publicKey, amount });
    }
  }
  return {
    demoPublic: session.demoPublic,
    sinkPublic,
    assets,
    recordedSigners: [...session.recordedSigners],
    offerCount: planned.offers,
    dataEntryCount: planned.dataEntries,
    transfers,
    conversions,
    claims,
    forfeits,
    sponsoredEntries,
  };
}

/**
 * The most operations a session's merge transaction can need: a return payment and a trustline
 * removal per asset, one cancellation per offer, one removal per data entry and per recorded
 * signer, one revoke per sponsored entry, the threshold reset that follows signer removal, and the
 * merge.
 */
export function maxOperations(expected: PlaygroundCloseExpectation): number {
  return (
    2 * expected.assets.length +
    expected.offerCount +
    expected.dataEntryCount +
    expected.recordedSigners.length +
    expected.sponsoredEntries.length +
    2
  );
}

function sharedExpectation(expected: PlaygroundCloseExpectation): CloseExpectationInput {
  const transfers: Record<string, TransferChoice> = {};
  const classicConversions: Record<string, { minAmountOut: string }> = {};
  const converted = new Set(expected.conversions.map((c) => c.asset));
  for (const { code, issuer } of expected.assets) {
    // A return to the issuer, as the web app expresses one: the destination is pinned to the
    // issuer encoded in the asset itself, so the amount is no floor at all. An asset chosen to
    // convert gets none, so the conversion is the only way it can leave.
    const asset = `${code}:${issuer}`;
    if (!converted.has(asset)) transfers[asset] = { destination: issuer, amount: "0" };
  }
  // A transfer replaces the return: its asset can then go to the recipient, and nowhere else.
  for (const { asset, destination, amount } of expected.transfers) {
    transfers[asset] = { destination, amount };
  }
  for (const { asset, minAmountOut } of expected.conversions) {
    classicConversions[asset] = { minAmountOut };
  }
  return {
    ...exitExpectations(null, "testnet"),
    source: expected.demoPublic,
    destination: expected.sinkPublic,
    // The sink is not an exchange, so the mediated hand-off this would floor is refused anyway.
    nativeBalance: "0",
    memo: null,
    memoType: null,
    claimTrustlineAssets: [
      ...new Set(expected.claims.filter((c) => c.addTrustline).map((c) => c.asset)),
    ],
    accountSigners: [expected.demoPublic, ...expected.recordedSigners].map((key) => ({
      key,
      weight: 1,
      type: "ed25519_public_key" as const,
    })),
    // The playground creates the demo account and never sets its thresholds.
    accountThresholds: { low: 0, med: 0, high: 0 },
    transfers,
    tokenTransfers: {},
    classicConversions,
    tokenConversions: {},
  };
}

/** A decimal amount as the SDK prints one (at most seven decimals), in stroops. */
export function amountToStroops(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount);
  if (!match) throw new PlaygroundVerificationError("amount_unreadable");
  const [, whole, fraction = ""] = match;
  return BigInt(whole) * BigInt(10_000_000) + BigInt(fraction.padEnd(7, "0"));
}

const assetKey = (asset: Asset): string => `${asset.getCode()}:${asset.getIssuer()}`;

/**
 * What the shared verifier does not hold: a transfer or a conversion moves no more than the mess
 * paid in. Run after it, so every payment and conversion reaching here is one the session chose.
 */
function assertWithinRecordedAmounts(
  ops: Transaction["operations"],
  expected: PlaygroundCloseExpectation
): void {
  for (const op of ops) {
    if (op.type === "payment" && !op.asset.isNative()) {
      const transfer = expected.transfers.find((t) => t.asset === assetKey(op.asset));
      if (transfer && amountToStroops(op.amount) > amountToStroops(transfer.amount)) {
        throw new PlaygroundVerificationError("transfer_above_recorded");
      }
    } else if (op.type === "pathPaymentStrictSend") {
      const conversion = op.sendAsset.isNative()
        ? undefined
        : expected.conversions.find((c) => c.asset === assetKey(op.sendAsset));
      if (!conversion) throw new PlaygroundVerificationError("conversion_not_chosen");
      if (amountToStroops(op.sendAmount) > amountToStroops(conversion.amount)) {
        throw new PlaygroundVerificationError("conversion_above_held");
      }
    }
  }
}

type Operations = Transaction["operations"];

const raisesTrustline = (op: Operations[number]): boolean =>
  op.type === "changeTrust" && Number(op.limit) > 0;

/**
 * A transaction without a merge is the claim transaction, which a session that recorded claims
 * may sign ahead of its close: nothing but claims of recorded balances, each once, and the
 * trustlines their assets need, each once and followed later in the transaction by its claim.
 */
function assertClaimTransaction(ops: Operations, expected: PlaygroundCloseExpectation): void {
  if (expected.claims.length === 0 || ops.length === 0) {
    throw new PlaygroundVerificationError("merge_not_final");
  }
  const claimed = new Set<string>();
  const added = new Set<string>();
  ops.forEach((op, i) => {
    if (op.type === "claimClaimableBalance") {
      if (!expected.claims.some((c) => c.id === op.balanceId)) {
        throw new PlaygroundVerificationError("claim_not_recorded");
      }
      if (claimed.has(op.balanceId)) throw new PlaygroundVerificationError("claim_duplicate");
      claimed.add(op.balanceId);
    } else if (op.type === "changeTrust" && raisesTrustline(op) && op.line instanceof Asset) {
      const asset = assetKey(op.line);
      const forAsset = expected.claims.filter((c) => c.addTrustline && c.asset === asset);
      if (forAsset.length === 0) {
        throw new PlaygroundVerificationError("claim_trustline_not_recorded");
      }
      if (added.has(asset)) throw new PlaygroundVerificationError("claim_trustline_duplicate");
      added.add(asset);
      const claimedLater = ops
        .slice(i + 1)
        .some(
          (later) =>
            later.type === "claimClaimableBalance" && forAsset.some((c) => c.id === later.balanceId)
        );
      if (!claimedLater) throw new PlaygroundVerificationError("claim_trustline_not_followed");
    } else {
      throw new PlaygroundVerificationError("merge_not_final");
    }
  });
}

/** In the merge transaction: no claim, no trustline added, and only recorded revokes, each once. */
function assertMergeTransaction(ops: Operations, expected: PlaygroundCloseExpectation): void {
  const revoked = new Set<string>();
  for (const op of ops) {
    if (op.type === "claimClaimableBalance") {
      throw new PlaygroundVerificationError("claim_outside_claim_transaction");
    }
    if (raisesTrustline(op)) {
      throw new PlaygroundVerificationError("trustline_add_outside_claim_transaction");
    }
    if (op.type !== "revokeTrustlineSponsorship" && op.type !== "revokeDataSponsorship") continue;
    // Its source is already held to the demo by the shared verifier, like every operation's.
    const entry =
      op.type === "revokeTrustlineSponsorship"
        ? expected.sponsoredEntries.find(
            (e) =>
              e.kind === "trustline" &&
              e.owner === op.account &&
              op.asset instanceof Asset &&
              e.asset === assetKey(op.asset)
          )
        : expected.sponsoredEntries.find(
            (e) => e.kind === "data_entry" && e.owner === op.account && e.name === op.name
          );
    if (!entry) throw new PlaygroundVerificationError("revoke_not_recorded");
    const key = JSON.stringify(entry);
    if (revoked.has(key)) throw new PlaygroundVerificationError("revoke_duplicate");
    revoked.add(key);
  }
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

  // Before the shared verifier, so this refusal does not depend on how it reads the operation.
  // CAP-33: only a cooperating new sponsor can take a claimable balance's reserve over.
  if (parsed.operations.some((op) => op.type === "revokeClaimableBalanceSponsorship")) {
    throw new PlaygroundVerificationError("revoke_claimable_balance_refused");
  }

  verifyCloseTransaction({
    unsignedXdr: tx.xdr,
    network: "testnet",
    expected: sharedExpectation(expected),
  });

  const ops = parsed.operations;
  if (!ops.every((op) => PLAYGROUND_CLOSE_OPERATION_TYPES.some((type) => type === op.type))) {
    throw new PlaygroundVerificationError("operation_not_allowed");
  }
  if (!ops.some((op) => op.type === "accountMerge")) {
    assertClaimTransaction(ops, expected);
    return;
  }
  assertMergeTransaction(ops, expected);
  assertWithinRecordedAmounts(ops, expected);
  if (ops.length > maxOperations(expected)) {
    throw new PlaygroundVerificationError("too_many_operations");
  }
  // The shared verifier already refuses a second merge; this pins the one merge to the end.
  if (ops.length === 0 || ops[ops.length - 1].type !== "accountMerge") {
    throw new PlaygroundVerificationError("merge_not_final");
  }
}
