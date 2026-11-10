import "server-only";
import { Asset, Networks, StrKey, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  exitExpectations,
  verifyCloseTransaction,
  type CloseExpectationInput,
  type ExitExpectations,
  type TransferChoice,
} from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import {
  AQUARIUS,
  BLEND,
  closesToExchange,
  conversionFloorStroops,
  EXCHANGE_STAND_IN,
  isPersistentAsset,
  MULTISIG_THRESHOLD,
  PHOENIX,
  PINNED_ASSETS,
  resolvePlan,
  SOROSWAP,
  type CloseOperationType,
  type MessStepDef,
} from "./scenarios";
import type { PlaygroundSession, SignerType } from "./session-store";
import { parseStroops } from "./stroops";
import { assertSorobanTransaction, type SeededProtocol } from "./verify-soroban";
import { PlaygroundVerificationError } from "./verify-error";
import {
  assertExchangeTransaction,
  isRelayHandOff,
  type ExchangeExpectation,
} from "./verify-mediator";

// The check the playground's backend runs on every XDR the real API returns, before signing it.
//
// The rules are not restated here. Every transaction goes through `@lumenwipe/verify`, the
// verifier compiled from the web app's own trust anchor (apps/web/lib/stellar/verify.ts), so the
// playground cannot drift from production: there is one allowlist and one set of operation rules.
// What makes it narrower is what it is told to expect, all of it taken from the session record and
// the playground's own configuration, never from the API's response:
//
// - the merge goes to the fixed sink, with no memo, unless the session closes to the exchange
//   (the last rule below);
// - a payment may only return an asset of the session to its own issuer, unless the session chose
//   another disposition for it: a transfer goes only to the session's own recipient, and an asset
//   chosen to convert can only be converted, to XLM, into the demo, for no less than the floor its
//   recorded amount and the playground's standing price give;
// - a signer may only be removed if the session recorded adding it, with the type it recorded;
// - a claim may only take a balance the session recorded creating for the demo, once, and a
//   trustline may only be added for the asset of such a balance, ahead of its claim;
// - a sponsorship may only be revoked on an entry the session recorded the demo sponsoring, and a
//   claimable balance's sponsorship never;
// - a Soroban contract call must first pass lib/verify-soroban.ts, which pins it to a protocol
//   the session's selection seeds, that protocol's pinned contracts, and its exit function with
//   the demo as its recipient; the shared verifier then holds it to the same protocol's exit
//   contracts, functions and tokens, filled from the selection and lib/scenarios/pinned.ts (the
//   way the web fills them from the account read the user reviewed), so both must pass. An exit
//   is a transaction of its own, never beside the merge;
// - a transaction may leave its own fee at zero only in a session that selected the sponsored fee
//   with a fee account configured, and the envelope the API's sponsor wraps it in must then pass
//   lib/verify-feebump.ts before it is sent;
// - a session that selected the exchange close deposits into the bundled registry's stand-in with
//   the memo it drew, through the API's relay account: every transaction first passes
//   lib/verify-mediator.ts (the two-operation hand-off, held to the balance the playground read
//   from Horizon this round; any other round neither merges nor carries a memo), and the shared
//   verifier is then told the stand-in, the memo and that balance. The cleanup round before the
//   hand-off is held to the merge transaction's rules below, less the merge.
//
// The shared verifier holds a transfer to a floor; the playground also holds a transfer and a
// conversion to at most the amount the mess paid in, so the two together pin a transfer exactly.
//
// On top of that, rules the shared verifier cannot hold for every close, because the exchange
// hand-off places its forward payment after the merge and a large close spans several
// transactions. The master key alone can sign, so the API adds no signer-normalization round, and
// the session's entries stay far below one transaction's operation limit, so a playground close is
// one transaction that ends in its merge, with no more operations than the session's entries can
// explain. There are two exceptions. A session that recorded claimable balances for the demo: the
// API claims them in a transaction of its own first (one round per request, lib/demolish.ts), and
// that transaction may hold nothing but those claims and the trustlines they need. A session whose
// mess raised the thresholds, so the master key alone cannot sign: the API removes the other
// signers in a transaction of its own first, which may hold nothing but removals of recorded
// signers, each once, and the reset to 0/1/1. Any other round that is not the final merge is
// refused before it is signed.

export { PlaygroundVerificationError };

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
  // A protocol exit, held to lib/verify-soroban.ts before the shared verifier runs.
  "invokeHostFunction",
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

/** A signer the session recorded adding, which the close may remove. */
export interface PlaygroundSigner {
  type: SignerType;
  key: string;
}

/** What a demolish of one session may do, from the session record and the playground config. */
export interface PlaygroundCloseExpectation {
  demoPublic: string;
  sinkPublic: string;
  assets: SessionAsset[];
  recordedSigners: PlaygroundSigner[];
  /** The mess raised the thresholds, so the close removes the other signers in a round of its own. */
  raisesThresholds: boolean;
  offerCount: number;
  dataEntryCount: number;
  transfers: PlaygroundTransfer[];
  conversions: PlaygroundConversion[];
  claims: PlaygroundClaim[];
  /** Balances the demo can claim only after the session, answered `forfeit`. */
  forfeits: string[];
  sponsoredEntries: PlaygroundSponsoredEntry[];
  /** The Soroban protocols the session's selection seeds; a call to any other is refused. */
  sorobanSeeded: SeededProtocol[];
  /** The session selected the sponsored fee, so its plan drains the demo below its own fee. */
  sponsored: boolean;
  /** The configured fee account, for a sponsored session: only with one may a transaction leave
   *  its own fee at zero for the API's sponsor to pay. Null otherwise, or with none configured. */
  sponsorFeeAccount: string | null;
  /** For a session that selected the exchange close, where it deposits and with which memo, and
   *  the balance read this round (lib/demolish.ts fills it in); null for any other session. */
  exchange: ExchangeExpectation | null;
}

/** A sponsored session's close left at a fee of zero, with no fee account configured to check the
 *  sponsor's envelope against: refused, and closed once the demo can pay its own fee. */
export const FEE_ACCOUNT_NOT_CONFIGURED = "zero_fee_fee_account_not_configured";

/**
 * The expectation for a session's demolish: the assets, offers, data entries and dispositions its
 * stored selection planned (lib/scenarios), the issuers and recipient it recorded, and the signers
 * it recorded. `persistentIssuer` is the playground's own issuer from its configuration (LWDEMO and
 * the disposition assets); every other asset must be one of the session's own ephemeral issuers.
 * `feeAccount` is the configured fee account the API's sponsor pays from, or null when there is
 * none; it is kept only for a session that selected the sponsored fee.
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
  > &
    Partial<Pick<PlaygroundSession, "exchange">>,
  sinkPublic: string,
  persistentIssuer: string,
  feeAccount: string | null
): PlaygroundCloseExpectation {
  const plan = resolvePlan(session.selection);
  const planned = plan.expectation;
  // A pinned asset's trustline is opened by its own step; its issuer is fixed configuration.
  const pinnedAssets = plan.steps.flatMap((s): SessionAsset[] =>
    s.action.kind === "pinned_trust"
      ? [{ code: PINNED_ASSETS[s.action.asset].code, issuer: PINNED_ASSETS[s.action.asset].issuer }]
      : []
  );
  const issuerOf = (code: string): string => {
    if (isPersistentAsset(code)) return persistentIssuer;
    const issuer = session.ephemeralIssuers.find((e) => e.assetCode === code);
    if (!issuer) throw new PlaygroundVerificationError("session_issuer_missing");
    return issuer.publicKey;
  };
  // A balance claimed through a new trustline leaves its asset on the account, closed like any other.
  const assets = [
    ...[...planned.assets, ...planned.arrivingAssets].map((code): SessionAsset => ({
      code,
      issuer: issuerOf(code),
    })),
    ...pinnedAssets,
  ];
  const claims = session.claimableBalances.flatMap((b): PlaygroundClaim[] =>
    b.intent === "claim" || b.intent === "add_trustline_then_claim"
      ? [{ id: b.id, asset: b.asset, addTrustline: b.intent === "add_trustline_then_claim" }]
      : []
  );
  const sponsored = plan.steps.some((s) => s.action.kind === "drain_to_fee_floor");
  const exchange = exchangeExpectation(session, sinkPublic, persistentIssuer);
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
    recordedSigners: session.recordedSigners.map(({ type, key }) => ({ type, key })),
    raisesThresholds: plan.steps.some((s) => s.action.kind === "multisig"),
    offerCount: planned.offers,
    dataEntryCount: planned.dataEntries,
    transfers,
    conversions,
    claims,
    forfeits,
    sponsoredEntries,
    sorobanSeeded: seededProtocols(plan.steps),
    sponsored,
    sponsorFeeAccount: sponsored ? feeAccount : null,
    exchange,
  };
}

/**
 * The exchange half of the expectation: the stand-in and memo the session recorded, which must be
 * there exactly when its selection closes to the exchange, and must name the bundled stand-in.
 * The balance is left unread; the round that signs reads it (lib/demolish.ts).
 */
function exchangeExpectation(
  session: Pick<
    PlaygroundSession,
    "demoPublic" | "ephemeralIssuers" | "selection" | "transferRecipient" | "helperAccounts"
  > &
    Partial<Pick<PlaygroundSession, "exchange">>,
  sinkPublic: string,
  persistentIssuer: string
): ExchangeExpectation | null {
  const recorded = session.exchange ?? null;
  if (!closesToExchange(session.selection)) {
    if (recorded !== null) throw new PlaygroundVerificationError("session_exchange_unexpected");
    return null;
  }
  if (recorded === null) throw new PlaygroundVerificationError("session_exchange_missing");
  if (recorded.destination !== EXCHANGE_STAND_IN.address || recorded.memoType !== "id") {
    throw new PlaygroundVerificationError("session_exchange_not_stand_in");
  }
  return {
    destination: recorded.destination,
    memo: recorded.memo,
    memoType: recorded.memoType,
    recordedBalance: null,
    sessionAccounts: [
      session.demoPublic,
      sinkPublic,
      persistentIssuer,
      ...session.ephemeralIssuers.map((e) => e.publicKey),
      ...(session.transferRecipient ? [session.transferRecipient.publicKey] : []),
      ...session.helperAccounts.map((h) => h.publicKey),
    ],
  };
}

/** The address the close goes to: the session's stand-in, or the market maker. */
export function closeDestination(expected: PlaygroundCloseExpectation): string {
  return expected.exchange?.destination ?? expected.sinkPublic;
}

/** The expectation with the balance the playground read from Horizon for this round. */
export function withRecordedBalance(
  expected: PlaygroundCloseExpectation,
  balance: string
): PlaygroundCloseExpectation {
  if (!expected.exchange) return expected;
  return { ...expected, exchange: { ...expected.exchange, recordedBalance: balance } };
}

/**
 * The protocols a plan seeds, read from its steps rather than from what has run: a seeding call
 * whose outcome was lost may still have landed, and an exit only ever pays the demo.
 */
export function seededProtocols(steps: readonly MessStepDef[]): SeededProtocol[] {
  const seeds = (kind: MessStepDef["action"]["kind"]): boolean =>
    steps.some((s) => s.action.kind === kind);
  // The Blend position's variant is the selection's: a repay is admitted only when it borrowed.
  const blend = steps.flatMap((s): SeededProtocol[] =>
    s.action.kind === "blend_submit" ? [{ protocol: "blend", variant: s.action.variant }] : []
  );
  // The Phoenix position's too: an unbond is admitted only when the plan bonds.
  const phoenix: SeededProtocol[] = seeds("phoenix_provide")
    ? [{ protocol: "phoenix", variant: seeds("phoenix_bond") ? "bonded" : "lp" }]
    : [];
  return [
    ...(seeds("soroswap_deposit") ? [{ protocol: "soroswap", variant: "lp" } as const] : []),
    ...(seeds("aquarius_deposit") ? [{ protocol: "aquarius", variant: "lp" } as const] : []),
    ...blend,
    ...phoenix,
  ];
}

type SorobanExitFields = Pick<
  ExitExpectations,
  | "exitContracts"
  | "exitFunctions"
  | "heldTokenContracts"
  | "positionTokenContracts"
  | "protectedTokenContracts"
  | "ownTokensByContract"
  | "repayTokensByPool"
  | "shareTokenContracts"
>;

/**
 * What the shared verifier admits for the session's protocol exits, built from the session's own
 * assets and lib/scenarios/pinned.ts alone, never from the API's response: the fields the web
 * fills from the account read, filled here from what the playground itself seeded.
 *
 * - `heldTokenContracts` / `protectedTokenContracts`: XLM and the Stellar Asset Contract of every
 *   asset the session holds a trustline for. The playground holds no Soroban-only balance, so the
 *   two are the same list.
 * - Soroswap: the router is the call target and the pair the position, with the router's one exit
 *   function and none on the pair (the shared verifier lets the router move the LP share into the
 *   pair only when the pair has no exit function of its own); the pair's two tokens are what the
 *   withdrawal pays out.
 * - Aquarius: the pool is both the call target and the position, with its one exit function; the
 *   share token is never a call target. Its own tokens are the two it pays out and the share token the
 *   withdrawal burns, which is also listed on its own as a share token, so an exit is refused
 *   outright should the session ever hold it for value.
 * - Blend: the pool is both the call target and the position, with its one exit function; XLM,
 *   the one reserve the scenario uses, is its own token. Only the borrow variant names XLM as a
 *   token the pool may be repaid in: the shared verifier lets a registry pool spend the demo's XLM
 *   for nothing else, so a supply-only session's exit can never move it.
 * - Phoenix: the pool and its stake contract are the call targets, with the pool's withdrawal and,
 *   only when the selection bonded, the stake's unbond. Its own tokens are the two it pays out and
 *   the share token the withdrawal takes back, which is also listed on its own as a share token.
 */
export function sorobanExitExpectations(expected: PlaygroundCloseExpectation): SorobanExitFields {
  const held = [
    Asset.native().contractId(Networks.TESTNET),
    ...expected.assets.map(({ code, issuer }) =>
      new Asset(code, issuer).contractId(Networks.TESTNET)
    ),
  ];
  const fields: SorobanExitFields = {
    exitContracts: [],
    exitFunctions: {},
    heldTokenContracts: [...new Set(held)],
    positionTokenContracts: [],
    protectedTokenContracts: [...new Set(held)],
    ownTokensByContract: {},
    repayTokensByPool: {},
    shareTokenContracts: [],
  };
  for (const seeded of expected.sorobanSeeded) {
    const { protocol } = seeded;
    if (protocol === "soroswap") {
      fields.exitContracts.push(SOROSWAP.router, SOROSWAP.pair);
      fields.exitFunctions[SOROSWAP.router] = ["remove_liquidity"];
      fields.exitFunctions[SOROSWAP.pair] = [];
      fields.positionTokenContracts.push(...SOROSWAP.tokens);
      fields.ownTokensByContract[SOROSWAP.pair] = [...SOROSWAP.tokens];
    } else if (protocol === "aquarius") {
      fields.exitContracts.push(AQUARIUS.pool);
      fields.exitFunctions[AQUARIUS.pool] = ["withdraw"];
      fields.positionTokenContracts.push(...AQUARIUS.tokens, AQUARIUS.shareToken);
      fields.ownTokensByContract[AQUARIUS.pool] = [...AQUARIUS.tokens, AQUARIUS.shareToken];
      fields.shareTokenContracts.push(AQUARIUS.shareToken);
    } else if (protocol === "blend") {
      fields.exitContracts.push(BLEND.pool);
      fields.exitFunctions[BLEND.pool] = ["submit"];
      fields.ownTokensByContract[BLEND.pool] = [BLEND.reserve];
      if (seeded.variant === "supply_and_borrow") {
        fields.repayTokensByPool[BLEND.pool] = [BLEND.reserve];
      }
    } else if (protocol === "phoenix") {
      const tokens = [PHOENIX.tokenA, PHOENIX.tokenB, PHOENIX.shareToken];
      fields.exitContracts.push(PHOENIX.pool, PHOENIX.stake);
      fields.exitFunctions[PHOENIX.pool] = ["withdraw_liquidity"];
      fields.exitFunctions[PHOENIX.stake] = seeded.variant === "bonded" ? ["unbond"] : [];
      fields.positionTokenContracts.push(...tokens);
      fields.ownTokensByContract[PHOENIX.pool] = tokens;
      fields.shareTokenContracts.push(PHOENIX.shareToken);
    }
  }
  // Pools can pay out the same token (XLM); each is listed once, as the web lists them.
  fields.positionTokenContracts = [...new Set(fields.positionTokenContracts)];
  return fields;
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

/**
 * The thresholds the session's own plan leaves on the demo: the account is created with 0/0/0,
 * and only a multi-signature step raises them, to `MULTISIG_THRESHOLD` in every category.
 */
export function sessionThresholds(expected: PlaygroundCloseExpectation): {
  low: number;
  med: number;
  high: number;
} {
  const t = expected.raisesThresholds ? MULTISIG_THRESHOLD : 0;
  return { low: t, med: t, high: t };
}

/** The shared verifier's expectation for a session, from its record and configuration alone. */
export function sharedExpectation(expected: PlaygroundCloseExpectation): CloseExpectationInput {
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
  const { exchange } = expected;
  return {
    ...exitExpectations(null, "testnet"),
    ...sorobanExitExpectations(expected),
    source: expected.demoPublic,
    destination: closeDestination(expected),
    // The sink is not an exchange, so the mediated hand-off this would floor is refused anyway.
    // The stand-in is, and its forward is floored at the balance the playground read itself.
    nativeBalance: exchange?.recordedBalance ?? "0",
    memo: exchange?.memo ?? null,
    memoType: exchange?.memoType ?? null,
    claimTrustlineAssets: [
      ...new Set(expected.claims.filter((c) => c.addTrustline).map((c) => c.asset)),
    ],
    accountSigners: [
      { key: expected.demoPublic, type: "ed25519_public_key" as const },
      ...expected.recordedSigners,
    ].map(({ key, type }) => ({ key, type, weight: 1 })),
    accountThresholds: sessionThresholds(expected),
    transfers,
    tokenTransfers: {},
    classicConversions,
    tokenConversions: {},
  };
}

/** A decimal amount as the SDK prints one (at most seven decimals), in stroops. */
export function amountToStroops(amount: string): bigint {
  const stroops = parseStroops(amount);
  if (stroops === null) throw new PlaygroundVerificationError("amount_unreadable");
  return stroops;
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

/** A setOptions signer as the close API names it, or null for a type the playground never adds. */
function removedSigner(op: Operations[number]): PlaygroundSigner | null {
  if (op.type !== "setOptions" || !op.signer) return null;
  const signer = op.signer;
  if ("ed25519PublicKey" in signer && signer.ed25519PublicKey) {
    return { type: "ed25519_public_key", key: signer.ed25519PublicKey };
  }
  if ("sha256Hash" in signer && signer.sha256Hash) {
    return { type: "hash_x", key: StrKey.encodeSha256Hash(Buffer.from(signer.sha256Hash)) };
  }
  if ("preAuthTx" in signer && signer.preAuthTx) {
    return { type: "preauth_tx", key: StrKey.encodePreAuthTx(Buffer.from(signer.preAuthTx)) };
  }
  return null;
}

/**
 * The transaction that removes the other signers ahead of a close the master key alone cannot
 * sign: only removals of signers the session recorded, each once, then the threshold reset to
 * exactly 0/1/1 as its last operation. The shared verifier has already refused a signer added or
 * empowered, a master weight change and any flag, home domain or inflation change.
 */
function assertNormalizationTransaction(
  ops: Operations,
  expected: PlaygroundCloseExpectation
): void {
  if (!expected.raisesThresholds) throw new PlaygroundVerificationError("merge_not_final");
  const removed = new Set<string>();
  ops.forEach((op, i) => {
    if (op.type !== "setOptions") throw new PlaygroundVerificationError("merge_not_final");
    const last = i === ops.length - 1;
    const thresholds = [op.lowThreshold, op.medThreshold, op.highThreshold];
    if (!op.signer) {
      const reset = op.lowThreshold === 0 && op.medThreshold === 1 && op.highThreshold === 1;
      if (!last || !reset) {
        throw new PlaygroundVerificationError("threshold_reset_invalid");
      }
      return;
    }
    if (last || thresholds.some((t) => t !== undefined)) {
      throw new PlaygroundVerificationError("threshold_reset_invalid");
    }
    const signer = removedSigner(op);
    if (
      !signer ||
      !expected.recordedSigners.some((s) => s.type === signer.type && s.key === signer.key)
    ) {
      throw new PlaygroundVerificationError("signer_not_recorded");
    }
    if (removed.has(signer.key)) throw new PlaygroundVerificationError("signer_removal_duplicate");
    removed.add(signer.key);
  });
}

/**
 * In an exchange session, the round before the hand-off that is neither the claim round nor the
 * signer round: what a direct close's merge transaction would hold, without the merge.
 */
function isExchangeCleanup(ops: Operations, expected: PlaygroundCloseExpectation): boolean {
  const claimRound =
    expected.claims.length > 0 &&
    ops.every((op) => op.type === "claimClaimableBalance" || raisesTrustline(op));
  const signerRound = expected.raisesThresholds && ops.every((op) => op.type === "setOptions");
  return ops.length > 0 && !claimRound && !signerRound;
}

/**
 * The cleanup round of an exchange session, held to the merge transaction's rules: no claim, no
 * trustline added, only recorded revokes, no transfer or conversion above what the mess paid in,
 * and no more operations than the session's entries explain, less the merge it does not carry.
 * lib/verify-mediator.ts has already refused a merge or a memo in it.
 */
function assertExchangeCleanup(ops: Operations, expected: PlaygroundCloseExpectation): void {
  assertMergeTransaction(ops, expected);
  assertWithinRecordedAmounts(ops, expected);
  if (ops.length > maxOperations(expected) - 1) {
    throw new PlaygroundVerificationError("too_many_operations");
  }
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
  // The API never wraps a close itself: a sponsored one comes back with its own fee at zero, and
  // only the playground sends it to the sponsor (lib/demolish.ts), once every rule holds.
  const parsed = TransactionBuilder.fromXdr(tx.xdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) {
    throw new PlaygroundVerificationError("fee_bump_not_allowed");
  }
  assertCloseRules(parsed, tx, expected);
  if (parsed.fee !== "0") return;
  if (!expected.sponsored) throw new PlaygroundVerificationError("zero_fee_not_sponsored");
  if (expected.sponsorFeeAccount === null) {
    throw new PlaygroundVerificationError(FEE_ACCOUNT_NOT_CONFIGURED);
  }
}

/** Every rule a playground close is held to, whoever pays its fee. */
function assertCloseRules(
  parsed: Transaction,
  tx: CloseTransaction,
  expected: PlaygroundCloseExpectation
): void {
  // Before the shared verifier, so this refusal does not depend on how it reads the operation.
  // CAP-33: only a cooperating new sponsor can take a claimable balance's reserve over.
  if (parsed.operations.some((op) => op.type === "revokeClaimableBalanceSponsorship")) {
    throw new PlaygroundVerificationError("revoke_claimable_balance_refused");
  }

  // Before the shared verifier too: a contract call must pass the playground's own structural
  // check, whatever the shared verifier would admit, and then the shared verifier as well.
  if (parsed.operations.some((op) => op.type === "invokeHostFunction")) {
    assertSorobanTransaction(parsed, {
      demoPublic: expected.demoPublic,
      seeded: expected.sorobanSeeded,
    });
  }

  // Before the shared verifier as well: the relay rules hold every transaction of an exchange
  // session to the stand-in, the session's memo and the balance read this round.
  if (expected.exchange) assertExchangeTransaction(parsed, expected.demoPublic, expected.exchange);

  verifyCloseTransaction({
    unsignedXdr: tx.xdr,
    network: "testnet",
    expected: sharedExpectation(expected),
  });

  const ops = parsed.operations;
  if (!ops.every((op) => PLAYGROUND_CLOSE_OPERATION_TYPES.some((type) => type === op.type))) {
    throw new PlaygroundVerificationError("operation_not_allowed");
  }
  // The hand-off: lib/verify-mediator.ts above held it to its two operations.
  if (expected.exchange && isRelayHandOff(parsed)) return;
  if (!ops.some((op) => op.type === "accountMerge")) {
    // A protocol exit: lib/verify-soroban.ts above already held it to one call, alone.
    if (ops.length === 1 && ops[0].type === "invokeHostFunction") return;
    if (expected.exchange && isExchangeCleanup(ops, expected)) {
      assertExchangeCleanup(ops, expected);
      return;
    }
    if (ops.length > 0 && ops.every((op) => op.type === "setOptions")) {
      assertNormalizationTransaction(ops, expected);
    } else {
      assertClaimTransaction(ops, expected);
    }
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
