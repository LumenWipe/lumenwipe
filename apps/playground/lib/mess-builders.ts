import "server-only";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  HORIZON_TESTNET_URL,
  loadHorizonAccount,
  submitClassicViaHorizon,
  TxSubmitError,
} from "./horizon-submit";
import {
  LWDEMO_CODE,
  type MessStepDef,
  type OfferAsset,
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
  /** Persists a signer in the session record before the step adds it to the demo account. */
  recordSigner: (publicKey: string) => Promise<void>;
}

function ephemeralIssuer(code: string, ctx: MessContext): Keypair {
  const issuer = ctx.ephemeralIssuers.get(code);
  if (!issuer) throw new Error(`Ephemeral issuer for ${code} not found in session`);
  return issuer;
}

function resolveAsset(code: OfferAsset, ctx: MessContext): Asset {
  if (code === "native") return Asset.native();
  if (code === LWDEMO_CODE) return new Asset(LWDEMO_CODE, ctx.persistentIssuer.publicKey());
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
  submit?: (signedXdr: string) => Promise<{ txHash: string }>;
  sleep?: (ms: number) => Promise<void>;
}

export async function buildSignSubmit(
  sourceKeypair: Keypair,
  ops: xdr.Operation[],
  extraSigners: Keypair[] = [],
  deps: BuildSignSubmitDeps = {}
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

export async function ensureMmOffer(mm: Keypair, issuerPublic: string): Promise<void> {
  const state = await loadHorizonAccount(mm.publicKey());
  void state; // presence check only; the actual "does the offer already exist" read
  // happens against Horizon's offers endpoint - kept intentionally simple for a
  // testnet-only demo account (unlike production, correctness here is not security-critical).
  const res = await fetch(`${HORIZON_TESTNET_URL}/accounts/${mm.publicKey()}/offers?limit=200`);
  const offers = (await res.json()) as {
    _embedded: {
      records: {
        selling: { asset_type: string };
        buying: { asset_code?: string; asset_issuer?: string };
      }[];
    };
  };
  const hasOffer = offers._embedded.records.some(
    (o) =>
      o.selling.asset_type === "native" &&
      o.buying.asset_code === LWDEMO_CODE &&
      o.buying.asset_issuer === issuerPublic
  );
  if (hasOffer) return;

  const accRes = await fetch(`${HORIZON_TESTNET_URL}/accounts/${mm.publicKey()}`);
  const acc = (await accRes.json()) as { balances: { asset_type: string; balance: string }[] };
  const nativeBalance = parseFloat(
    acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0"
  );
  const spendable = nativeBalance - 10;
  const amount = Math.min(spendable, 5000);
  if (amount < 50) {
    console.error(
      `[playground] MM ${mm.publicKey()} balance too low to post liquidity offer (${nativeBalance} XLM)`
    );
    return;
  }
  await buildSignSubmit(mm, [
    Operation.manageSellOffer({
      selling: Asset.native(),
      buying: new Asset(LWDEMO_CODE, issuerPublic),
      amount: amount.toFixed(7),
      price: "2",
    }),
  ]);
}

type Submit = (source: Keypair, ops: xdr.Operation[], extraSigners?: Keypair[]) => Promise<string>;

type Executor<K extends StepActionKind> = (
  action: Extract<StepAction, { kind: K }>,
  ctx: MessContext,
  submit: Submit,
  deps: BuildSignSubmitDeps
) => Promise<string>;

/** One executor per step action kind in the scenario registry. */
export const MESS_EXECUTORS: { [K in StepActionKind]: Executor<K> } = {
  setup: (action, ctx, submit) => {
    const ephemeralCost = action.ephemeralAssets.length * parseFloat(action.issuerFundingXlm);
    const returnAmount = (
      parseFloat(action.friendbotXlm) -
      parseFloat(action.keepXlm) -
      ephemeralCost
    ).toFixed(7);
    return submit(ctx.demo, [
      ...action.ephemeralAssets.map((code) =>
        Operation.createAccount({
          destination: ephemeralIssuer(code, ctx).publicKey(),
          startingBalance: action.issuerFundingXlm,
        })
      ),
      Operation.payment({ destination: ctx.mmPublic, asset: Asset.native(), amount: returnAmount }),
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
};

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
  const submit: Submit = (source, ops, extraSigners = []) =>
    buildSignSubmit(source, ops, extraSigners, deps);
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
  await ctx.recordSigner(forgotten);
  return buildSignSubmit(
    ctx.demo,
    [Operation.setOptions({ signer: { ed25519PublicKey: forgotten, weight: 1 } })],
    [],
    deps
  );
}
