import "server-only";
import { randomBytes } from "node:crypto";
import {
  Account,
  Address,
  Asset,
  Claimant,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  HORIZON_TESTNET_URL,
  loadHorizonAccount,
  loadNativeBalance,
  submitClassicViaHorizon,
  TxSubmitError,
  type NativeBalance,
} from "./horizon-submit";
import { seedContractCall, type ContractCall } from "./soroban-seed";
import { formatStroops, networkStroops, parseStroops } from "./stroops";
import { standingLiquidityOps, type HorizonBalance, type HorizonOffer } from "./standing-liquidity";
import type { SignerType } from "./session-store";
import {
  MULTISIG_SIGNER_WEIGHT,
  MULTISIG_THRESHOLD,
  TIME_GATE_SECONDS,
  SPONSORED_OFFER,
  PINNED_ASSETS,
  SOROSWAP,
  isPersistentAsset,
  type AssetCode,
  type ClaimIntent,
  type HelperRole,
  type MessStepDef,
  type MultisigVariant,
  type ResolutionKind,
  type OfferAsset,
  type PinnedAssetId,
  type StepAction,
  type StepActionKind,
} from "./scenarios";

export { TxSubmitError };

// Server-only: builds, signs and submits one real testnet transaction per
// mess step. Secrets only ever exist in memory inside the route handler.

const PASSPHRASE = "Test SDF Network ; September 2015";
const ACCOUNT_VISIBILITY_DELAY_MS = 2000;
const ACCOUNT_VISIBILITY_MAX_ATTEMPTS = 6;
const SUBMIT_RETRY_MAX_ATTEMPTS = 5;
const SUBMIT_RETRY_DELAY_MS = 3000;
const TX_TIMEOUT_SECONDS = 30;
const RETRYABLE_SUBMIT_CODES = new Set(["tx_bad_seq", "tx_no_account"]);

export interface MessContext {
  demo: Keypair;
  ephemeralIssuers: Map<string, Keypair>;
  persistentIssuer: Keypair;
  mmPublic: string;
  /** The session's transfer recipient, which the OPEN_RECIPIENT step creates; null without one. */
  transferRecipient: Keypair | null;
  /** The claimant, sponsor or beneficiary the session holds a key for. */
  helpers: ReadonlyMap<HelperRole, Keypair>;
  /** Persists a signer in the session record before the step adds it to the demo account. */
  recordSigner: (signer: NewSigner) => Promise<void>;
  /** Records the claimable balances a signed transaction creates, before it is sent. Each attempt
   *  replaces the last: only the transaction that lands creates balances. */
  recordClaimableBalances: (balances: ClaimableBalanceRecord[]) => Promise<void>;
}

/**
 * A signer a step is about to add, with what signs for it in the clear: an ed25519 secret key or a
 * hash(x) preimage in hex, or null when nothing can. The route encrypts `secret` before it is
 * stored, so it exists in plain text only in this request's memory.
 */
export interface NewSigner {
  type: SignerType;
  key: string;
  weight: number;
  secret: string | null;
}

export interface ClaimableBalanceRecord {
  id: string;
  /** `CODE:ISSUER` or `native`. */
  asset: string;
  intent: ClaimIntent;
}

function helper(role: HelperRole, ctx: Pick<MessContext, "helpers">): Keypair {
  const kp = ctx.helpers.get(role);
  if (!kp) throw new Error(`No ${role} account in the session`);
  return kp;
}

function ephemeralIssuer(code: string, ctx: MessContext): Keypair {
  const issuer = ctx.ephemeralIssuers.get(code);
  if (!issuer) throw new Error(`Ephemeral issuer for ${code} not found in session`);
  return issuer;
}

function resolveAsset(code: OfferAsset, ctx: MessContext): Asset {
  if (code === "native") return Asset.native();
  if (isPersistentAsset(code)) return new Asset(code, ctx.persistentIssuer.publicKey());
  return new Asset(code, ephemeralIssuer(code, ctx).publicKey());
}

const isAccountNotFound = (err: unknown): boolean =>
  /account not found/i.test(err instanceof Error ? err.message : String(err));

export async function loadAccountWithRetry<T>(
  fetchAccount: (address: string) => Promise<T>,
  address: string,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const attempts = opts.attempts ?? ACCOUNT_VISIBILITY_MAX_ATTEMPTS;
  const delayMs = opts.delayMs ?? ACCOUNT_VISIBILITY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fetchAccount(address);
    } catch (err) {
      if (!isAccountNotFound(err)) throw err;
      lastErr = err;
      if (attempt < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface BuildSignSubmitDeps {
  loadAccount?: (address: string) => Promise<{ sequenceNumber: () => string }>;
  /** Reads an account's XLM; the setup step sizes its return payment from it. */
  loadNativeBalance?: (address: string) => Promise<NativeBalance>;
  submit?: (signedXdr: string) => Promise<{ txHash: string }>;
  sleep?: (ms: number) => Promise<void>;
  /** The cheapest route the testnet DEX quotes for buying `amount` of `asset` with XLM. */
  quoteBuy?: (asset: Asset, amount: string) => Promise<BuyQuote | null>;
  /** Makes one contract call as `source` and waits for it (lib/soroban-seed.ts). */
  contractCall?: (source: Keypair, call: ContractCall) => Promise<{ txHash: string }>;
  now?: () => number;
}

/** A strict-receive route: the XLM it spends and the assets it crosses on the way. */
export interface BuyQuote {
  sourceAmount: string;
  path: Asset[];
}

/**
 * The testnet DEX cannot sell a pinned asset for what the scenario allows. Thrown before anything
 * is signed for the step, and shown to the visitor in plain language (lib/error-copy.ts).
 */
export class LiquidityUnavailableError extends Error {
  constructor(readonly asset: PinnedAssetId) {
    super(`No testnet route sells ${asset} for XLM within the scenario's ceiling`);
    this.name = "LiquidityUnavailableError";
  }
}

export async function buildSignSubmit(
  sourceKeypair: Keypair,
  ops: xdr.Operation[],
  extraSigners: Keypair[] = [],
  deps: BuildSignSubmitDeps = {},
  onSigned?: (tx: Transaction) => Promise<void>
): Promise<string> {
  const loadAccount = deps.loadAccount ?? loadHorizonAccount;
  const submit = deps.submit ?? submitClassicViaHorizon;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt < SUBMIT_RETRY_MAX_ATTEMPTS; attempt++) {
    const live = await loadAccountWithRetry(loadAccount, sourceKeypair.publicKey());
    const account = new Account(sourceKeypair.publicKey(), live.sequenceNumber());

    const builder = new TransactionBuilder(account, {
      fee: String(100 * Math.max(ops.length, 1) * 2),
      networkPassphrase: PASSPHRASE,
    }).setTimeout(TX_TIMEOUT_SECONDS);
    ops.forEach((op) => builder.addOperation(op));

    const tx = builder.build();
    tx.sign(sourceKeypair, ...extraSigners);
    if (onSigned) await onSigned(tx);

    try {
      const { txHash } = await submit(tx.toEnvelope().toXdr("base64"));
      return txHash;
    } catch (err) {
      lastErr = err;
      const isTransient =
        err instanceof TxSubmitError &&
        err.resultCode != null &&
        RETRYABLE_SUBMIT_CODES.has(err.resultCode);
      if (isTransient && attempt < SUBMIT_RETRY_MAX_ATTEMPTS - 1) {
        await sleep(SUBMIT_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function horizonJson<T>(path: string): Promise<T> {
  const res = await fetch(`${HORIZON_TESTNET_URL}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Horizon read failed (${res.status})`);
  return (await res.json()) as T;
}

interface HorizonPathRecord {
  source_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
}

const pathAsset = (p: HorizonPathRecord["path"][number]): Asset =>
  p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer);

/** Horizon's cheapest strict-receive route from XLM to `amount` of `asset`, or null for none. */
export async function quoteBuyOnHorizon(asset: Asset, amount: string): Promise<BuyQuote | null> {
  const query = new URLSearchParams({
    source_assets: "native",
    destination_asset_type: asset.getAssetType(),
    destination_asset_code: asset.getCode(),
    destination_asset_issuer: asset.getIssuer() ?? "",
    destination_amount: amount,
  });
  const body = await horizonJson<{ _embedded: { records: HorizonPathRecord[] } }>(
    `/paths/strict-receive?${query.toString()}`
  );
  let best: BuyQuote | null = null;
  for (const record of body._embedded.records) {
    const cost = parseStroops(record.source_amount);
    if (cost === null) continue;
    if (best === null || cost < networkStroops(best.sourceAmount)) {
      best = { sourceAmount: record.source_amount, path: record.path.map(pathAsset) };
    }
  }
  return best;
}

/**
 * The route a pinned asset is bought by, refused unless the DEX quotes one within `maxXlm`. Run
 * before the trustline is opened as well as before the purchase, so no key signs anything for a
 * scenario the testnet market cannot serve.
 */
export async function buyRoute(
  id: PinnedAssetId,
  amount: string,
  maxXlm: string,
  deps: Pick<BuildSignSubmitDeps, "quoteBuy">
): Promise<BuyQuote> {
  const quoteBuy = deps.quoteBuy ?? quoteBuyOnHorizon;
  const quote = await quoteBuy(pinnedAsset(id), amount);
  if (quote === null || networkStroops(quote.sourceAmount) > networkStroops(maxXlm)) {
    throw new LiquidityUnavailableError(id);
  }
  return quote;
}

function pinnedAsset(id: PinnedAssetId): Asset {
  const { code, issuer } = PINNED_ASSETS[id];
  return new Asset(code, issuer);
}

/** How long a seeding call's deadline gives the router, in seconds. */
const DEPOSIT_DEADLINE_SECONDS = 300;

const scAddress = (address: string): xdr.ScVal => new Address(address).toScVal();
const scI128 = (stroops: bigint): xdr.ScVal => nativeToScVal(stroops, { type: "i128" });

/**
 * The router call that pairs the demo's USDC with XLM: `add_liquidity(token_a, token_b,
 * amount_a_desired, amount_b_desired, amount_a_min, amount_b_min, to, deadline)`, in the pair's
 * own token order. The router takes all the USDC and only the XLM the pool's price needs, or the
 * other way round if the price moved, so the minimums are one stroop: this is the demo's own
 * deposit, and the exit's floors are what protect what comes back.
 */
export function soroswapDepositCall(
  demoPublic: string,
  usdc: string,
  maxXlm: string,
  nowMs: number
): ContractCall {
  const [usdcToken, xlmToken] = SOROSWAP.tokens;
  return {
    contract: SOROSWAP.router,
    function: "add_liquidity",
    args: [
      scAddress(usdcToken),
      scAddress(xlmToken),
      scI128(networkStroops(usdc)),
      scI128(networkStroops(maxXlm)),
      scI128(BigInt(1)),
      scI128(BigInt(1)),
      scAddress(demoPublic),
      nativeToScVal(BigInt(Math.floor(nowMs / 1000) + DEPOSIT_DEADLINE_SECONDS), { type: "u64" }),
    ],
  };
}

/** Posts or refills the market maker's standing offers; a no-op when they are all in place. */
export async function ensureStandingLiquidity(mm: Keypair, issuerPublic: string): Promise<void> {
  const [account, offers] = await Promise.all([
    horizonJson<{ balances: HorizonBalance[] }>(`/accounts/${mm.publicKey()}`),
    horizonJson<{ _embedded: { records: HorizonOffer[] } }>(
      `/accounts/${mm.publicKey()}/offers?limit=200`
    ),
  ]);
  const native = account.balances.find((b) => b.asset_type === "native");
  const { ops, unfunded } = standingLiquidityOps(
    issuerPublic,
    Number(native?.balance ?? "0"),
    account.balances,
    offers._embedded.records
  );
  if (unfunded.length > 0) {
    // A conversion of these assets finds no route until the market maker is topped up.
    console.warn("[playground] market maker too low to post standing liquidity", {
      mm: mm.publicKey(),
      assets: unfunded,
    });
  }
  if (ops.length > 0) await buildSignSubmit(mm, ops);
}

/**
 * Empties and merges the session's transfer recipient into the market maker: each transferred
 * balance goes back to the persistent issuer, each trustline is removed, then the merge. The
 * balances are the amounts the session recorded, not a read: before the close has transferred
 * anything there is nothing to return, so only the trustlines are removed.
 */
export function retireRecipientOps(
  persistentIssuer: string,
  mmPublic: string,
  trusted: readonly AssetCode[],
  received: readonly { asset: AssetCode; amount: string }[]
): xdr.Operation[] {
  return [
    ...received.map(({ asset, amount }) =>
      Operation.payment({
        destination: persistentIssuer,
        asset: new Asset(asset, persistentIssuer),
        amount,
      })
    ),
    ...trusted.map((code) =>
      Operation.changeTrust({ asset: new Asset(code, persistentIssuer), limit: "0" })
    ),
    Operation.accountMerge({ destination: mmPublic }),
  ];
}

type Submit = (
  source: Keypair,
  ops: xdr.Operation[],
  extraSigners?: Keypair[],
  onSigned?: (tx: Transaction) => Promise<void>
) => Promise<string>;

type Executor<K extends StepActionKind> = (
  action: Extract<StepAction, { kind: K }>,
  ctx: MessContext,
  submit: Submit,
  deps: BuildSignSubmitDeps
) => Promise<string>;

/** One executor per step action kind in the scenario registry. */
export const MESS_EXECUTORS: { [K in StepActionKind]: Executor<K> } = {
  // Anything the demo holds beyond what the market maker funded it with goes back to it, read from
  // the account rather than assumed.
  setup: async (action, ctx, submit, deps) => {
    const read = deps.loadNativeBalance ?? loadNativeBalance;
    const { balance } = await read(ctx.demo.publicKey());
    const excess = networkStroops(balance) - networkStroops(action.fundingXlm);
    return submit(ctx.demo, [
      ...action.ephemeralAssets.map((code) =>
        Operation.createAccount({
          destination: ephemeralIssuer(code, ctx).publicKey(),
          startingBalance: action.issuerFundingXlm,
        })
      ),
      ...(excess > BigInt(0)
        ? [
            Operation.payment({
              destination: ctx.mmPublic,
              asset: Asset.native(),
              amount: formatStroops(excess),
            }),
          ]
        : []),
    ]);
  },
  change_trust: (action, ctx, submit) =>
    submit(ctx.demo, [Operation.changeTrust({ asset: resolveAsset(action.asset, ctx) })]),
  airdrops: (action, ctx, submit) => {
    if (action.payments.length === 0) throw new Error("airdrops step with no payments");
    const ops = action.payments.map(({ asset, amount }) =>
      Operation.payment({
        source: ephemeralIssuer(asset, ctx).publicKey(),
        destination: ctx.demo.publicKey(),
        asset: resolveAsset(asset, ctx),
        amount,
      })
    );
    const signers = action.payments.map(({ asset }) => ephemeralIssuer(asset, ctx));
    return submit(ctx.demo, ops, signers);
  },
  issuer_payment: (action, ctx, submit) =>
    submit(ctx.persistentIssuer, [
      Operation.payment({
        destination: ctx.demo.publicKey(),
        asset: resolveAsset(action.asset, ctx),
        amount: action.amount,
      }),
    ]),
  dex_swap: (action, ctx, submit) => {
    const issuer = ephemeralIssuer(action.asset, ctx);
    const asset = resolveAsset(action.asset, ctx);
    const cost = (parseFloat(action.amount) * parseFloat(action.price)).toFixed(7);
    return submit(
      ctx.demo,
      [
        Operation.manageSellOffer({
          source: issuer.publicKey(),
          selling: asset,
          buying: Asset.native(),
          amount: action.amount,
          price: action.price,
        }),
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: cost,
          destination: ctx.demo.publicKey(),
          destAsset: asset,
          destAmount: action.amount,
          path: [],
        }),
      ],
      [issuer]
    );
  },
  manage_data: (action, ctx, submit) =>
    submit(
      ctx.demo,
      action.entries.map(({ key, value }) => Operation.manageData({ name: key, value }))
    ),
  offers: (action, ctx, submit) =>
    submit(
      ctx.demo,
      action.offers.map((o) =>
        Operation.manageSellOffer({
          selling: resolveAsset(o.selling, ctx),
          buying: resolveAsset(o.buying, ctx),
          amount: o.amount,
          price: o.price,
        })
      )
    ),
  add_signer: (_action, ctx, _submit, deps) => addForgottenSigner(ctx, deps),
  pinned_trust: async (action, ctx, submit, deps) => {
    await buyRoute(action.asset, action.amount, action.maxXlm, deps);
    return submit(ctx.demo, [Operation.changeTrust({ asset: pinnedAsset(action.asset) })]);
  },
  pinned_buy: async (action, ctx, submit, deps) => {
    const route = await buyRoute(action.asset, action.amount, action.maxXlm, deps);
    return submit(ctx.demo, [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        // The ceiling, not the quote: the price may move between the two, and the ceiling is the
        // most the scenario agreed to spend.
        sendMax: action.maxXlm,
        destination: ctx.demo.publicKey(),
        destAsset: pinnedAsset(action.asset),
        destAmount: action.amount,
        path: route.path,
      }),
    ]);
  },
  soroswap_deposit: async (action, ctx, _submit, deps) => {
    const contractCall = deps.contractCall ?? seedContractCall;
    const now = deps.now ?? Date.now;
    const deposit = soroswapDepositCall(ctx.demo.publicKey(), action.usdc, action.maxXlm, now());
    return (await contractCall(ctx.demo, deposit)).txHash;
  },
  // Every signer is recorded before the transaction that adds it is sent. The thresholds rise in
  // the same transaction, which the master key alone still authorizes: signatures are checked
  // against the account as it was before any of its operations applies.
  multisig: async (action, ctx, submit) => {
    const signers = multisigSigners(action.variant, ctx.demo.publicKey());
    for (const signer of signers) await ctx.recordSigner(signer);
    return submit(ctx.demo, [
      ...signers.map(addSignerOp),
      Operation.setOptions({
        lowThreshold: MULTISIG_THRESHOLD,
        medThreshold: MULTISIG_THRESHOLD,
        highThreshold: MULTISIG_THRESHOLD,
      }),
    ]);
  },
  // The demo creates the recipient, which trusts the assets it will receive, in one transaction.
  open_recipient: (action, ctx, submit) => {
    const recipient = ctx.transferRecipient;
    if (!recipient) throw new Error("open_recipient step with no recipient in the session");
    return submit(
      ctx.demo,
      [
        Operation.createAccount({
          destination: recipient.publicKey(),
          startingBalance: action.fundingXlm,
        }),
        ...action.assets.map((code) =>
          Operation.changeTrust({ source: recipient.publicKey(), asset: resolveAsset(code, ctx) })
        ),
      ],
      [recipient]
    );
  },
  claimable_balances: (action, ctx, submit) => {
    const demo = ctx.demo.publicKey();
    const ops: xdr.Operation[] = [];
    const signers = new Map<string, Keypair>();
    const created: { index: number; asset: string; intent: ClaimIntent }[] = [];
    const sponsoredByDemo = action.balances.some((b) => b.intent === "demo_sponsored");
    if (sponsoredByDemo) {
      ops.push(
        Operation.createAccount({
          destination: helper("claimant", ctx).publicKey(),
          startingBalance: action.claimantFundingXlm,
        })
      );
    }
    for (const balance of action.balances) {
      if (balance.intent === "demo_sponsored") {
        // Created, and so sponsored, by the demo for the claimant: the demo is not a claimant.
        created.push({ index: ops.length, asset: "native", intent: balance.intent });
        ops.push(
          Operation.createClaimableBalance({
            asset: Asset.native(),
            amount: balance.amount,
            claimants: [new Claimant(helper("claimant", ctx).publicKey())],
          })
        );
        continue;
      }
      if (balance.asset === "native") throw new Error("Only the demo creates a native balance");
      const issuer = ephemeralIssuer(balance.asset, ctx);
      const asset = resolveAsset(balance.asset, ctx);
      // A forfeited balance also names its issuer, so cleanup can claim it back and merge it.
      const claimants =
        balance.intent === "forfeit"
          ? [
              new Claimant(
                demo,
                Claimant.predicateNot(Claimant.predicateBeforeRelativeTime(TIME_GATE_SECONDS))
              ),
              new Claimant(issuer.publicKey()),
            ]
          : [new Claimant(demo)];
      created.push({
        index: ops.length,
        asset: `${asset.getCode()}:${asset.getIssuer()}`,
        intent: balance.intent,
      });
      ops.push(
        Operation.createClaimableBalance({
          source: issuer.publicKey(),
          asset,
          amount: balance.amount,
          claimants,
        })
      );
      signers.set(issuer.publicKey(), issuer);
    }
    return submit(ctx.demo, ops, [...signers.values()], (tx) =>
      ctx.recordClaimableBalances(
        created.map(({ index, asset, intent }) => ({
          id: tx.getClaimableBalanceId(index),
          asset,
          intent,
        }))
      )
    );
  },
  sponsored_entries: (action, ctx, submit) => {
    const demo = ctx.demo.publicKey();
    const asset = resolveAsset(action.asset, ctx);
    const { key, value } = action.dataEntry;
    if (action.variant === "sponsor_pays") {
      const sponsor = helper("sponsor", ctx);
      return submit(
        ctx.demo,
        [
          Operation.createAccount({
            destination: sponsor.publicKey(),
            startingBalance: action.helperFundingXlm,
          }),
          Operation.beginSponsoringFutureReserves({
            source: sponsor.publicKey(),
            sponsoredId: demo,
          }),
          Operation.changeTrust({ asset }),
          Operation.manageData({ name: key, value }),
          Operation.manageSellOffer({
            selling: Asset.native(),
            buying: asset,
            amount: SPONSORED_OFFER.amount,
            price: SPONSORED_OFFER.price,
          }),
          Operation.endSponsoringFutureReserves({}),
        ],
        [sponsor]
      );
    }
    const beneficiary = helper("beneficiary", ctx);
    const owner = beneficiary.publicKey();
    return submit(
      ctx.demo,
      [
        Operation.createAccount({ destination: owner, startingBalance: action.helperFundingXlm }),
        Operation.beginSponsoringFutureReserves({ sponsoredId: owner }),
        Operation.changeTrust({ source: owner, asset }),
        Operation.manageData({ source: owner, name: key, value }),
        Operation.endSponsoringFutureReserves({ source: owner }),
      ],
      [beneficiary]
    );
  },
};

export interface ResolutionContext {
  helpers: ReadonlyMap<HelperRole, Keypair>;
  /** The balance the demo created for the claimant, as the session recorded it. */
  demoSponsoredBalanceId: string | null;
  /** The beneficiary's sponsored trustline asset and data entry, from the plan. */
  sponsored: { asset: Asset; dataKey: string } | null;
}

/** The transaction each planned resolution sends, signed by the helper that owns the entry. */
export function resolutionTransaction(
  kind: ResolutionKind,
  ctx: ResolutionContext
): { source: Keypair; ops: xdr.Operation[] } {
  if (kind === "claim_sponsored_balance") {
    if (!ctx.demoSponsoredBalanceId) throw new Error("No recorded balance to claim");
    return {
      source: helper("claimant", ctx),
      ops: [Operation.claimClaimableBalance({ balanceId: ctx.demoSponsoredBalanceId })],
    };
  }
  if (!ctx.sponsored) throw new Error("No sponsored entries to release");
  return {
    source: helper("beneficiary", ctx),
    ops: [
      Operation.changeTrust({ asset: ctx.sponsored.asset, limit: "0" }),
      Operation.manageData({ name: ctx.sponsored.dataKey, value: null }),
    ],
  };
}

function runAction<K extends StepActionKind>(
  action: Extract<StepAction, { kind: K }>,
  ctx: MessContext,
  submit: Submit,
  deps: BuildSignSubmitDeps
): Promise<string> {
  const executor: Executor<K> = MESS_EXECUTORS[action.kind];
  return executor(action, ctx, submit, deps);
}

/** `deps` reaches every submission, so a test can capture the signed transactions instead of sending them. */
export function executeMessStep(
  step: MessStepDef,
  ctx: MessContext,
  deps: BuildSignSubmitDeps = {}
): Promise<string> {
  const submit: Submit = (source, ops, extraSigners = [], onSigned) =>
    buildSignSubmit(source, ops, extraSigners, deps, onSigned);
  return runAction(step.action, ctx, submit, deps);
}

/**
 * Adds a co-signer whose secret is discarded: weight 1 with thresholds 0/1/1 never blocks the
 * master key, and the demolish removes it. lib/verify.ts lets a close remove only a signer the
 * session recorded, so it is recorded before the transaction that adds it is sent.
 */
export async function addForgottenSigner(
  ctx: Pick<MessContext, "demo" | "recordSigner">,
  deps: BuildSignSubmitDeps = {}
): Promise<string> {
  const forgotten = Keypair.random().publicKey();
  await ctx.recordSigner({ type: "ed25519_public_key", key: forgotten, weight: 1, secret: null });
  return buildSignSubmit(
    ctx.demo,
    [Operation.setOptions({ signer: { ed25519PublicKey: forgotten, weight: 1 } })],
    [],
    deps
  );
}

const cosigner = (): NewSigner => {
  const kp = Keypair.random();
  return {
    type: "ed25519_public_key",
    key: kp.publicKey(),
    weight: MULTISIG_SIGNER_WEIGHT,
    secret: kp.secret(),
  };
};

/**
 * The key of a pre-authorized transaction that can never be submitted: a sequence bump whose time
 * bounds closed in 1970. Nothing is kept but the key; the close removes the signer like any other.
 */
export function dormantPreAuthKey(demoPublic: string): string {
  const tx = new TransactionBuilder(new Account(demoPublic, "0"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: 0, maxTime: 1 },
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .build();
  return StrKey.encodePreAuthTx(tx.hash());
}

/** The signers a multi-signature variant adds, each with weight `MULTISIG_SIGNER_WEIGHT`. */
export function multisigSigners(variant: MultisigVariant, demoPublic: string): NewSigner[] {
  if (variant === "hash_x") {
    const preimage = randomBytes(32);
    return [
      {
        type: "hash_x",
        key: StrKey.encodeSha256Hash(hash(preimage)),
        weight: MULTISIG_SIGNER_WEIGHT,
        secret: preimage.toString("hex"),
      },
    ];
  }
  const cosigners = [cosigner(), cosigner()];
  if (variant === "two_of_three") return cosigners;
  return [
    ...cosigners,
    {
      type: "preauth_tx",
      key: dormantPreAuthKey(demoPublic),
      weight: MULTISIG_SIGNER_WEIGHT,
      secret: null,
    },
  ];
}

function addSignerOp({ type, key, weight }: NewSigner): xdr.Operation {
  if (type === "hash_x") {
    return Operation.setOptions({ signer: { sha256Hash: StrKey.decodeSha256Hash(key), weight } });
  }
  if (type === "preauth_tx") {
    return Operation.setOptions({ signer: { preAuthTx: StrKey.decodePreAuthTx(key), weight } });
  }
  return Operation.setOptions({ signer: { ed25519PublicKey: key, weight } });
}
