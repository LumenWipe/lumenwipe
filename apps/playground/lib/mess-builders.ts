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
  DEMO_KEEP_XLM,
  DEMO_SWAP_PRICE,
  EPHEMERAL_ISSUER_FUNDING_XLM,
  EURC_DEMO_AMOUNT,
  JUNK_DATA_ENTRIES,
  JUNK_OFFERS,
  LWDEMO_AMOUNT,
  LWDEMO_CODE,
  USDC_DEMO_AMOUNT,
  type MessStepId,
} from "./mess-plan";

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
  fundRareAssets: string[];
  offerCount: number;
  dataEntryCount: number;
}

function resolveAsset(code: string, ctx: MessContext): Asset {
  if (code === "native") return Asset.native();
  if (code === LWDEMO_CODE) return new Asset(LWDEMO_CODE, ctx.persistentIssuer.publicKey());
  const issuer = ctx.ephemeralIssuers.get(code);
  if (!issuer) throw new Error(`Ephemeral issuer for ${code} not found in session`);
  return new Asset(code, issuer.publicKey());
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
      const { txHash } = await submit(tx.toEnvelope().toXDR("base64"));
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

export async function executeMessStep(stepId: MessStepId, ctx: MessContext): Promise<string> {
  const demoPublic = ctx.demo.publicKey();

  switch (stepId) {
    case "SETUP": {
      const ephemeralCodes = [...ctx.ephemeralIssuers.keys()];
      const ephemeralCost = ephemeralCodes.length * parseFloat(EPHEMERAL_ISSUER_FUNDING_XLM);
      const returnAmount = (10000 - parseFloat(DEMO_KEEP_XLM) - ephemeralCost).toFixed(7);

      const ops = [
        ...ephemeralCodes.map((code) =>
          Operation.createAccount({
            destination: ctx.ephemeralIssuers.get(code)!.publicKey(),
            startingBalance: EPHEMERAL_ISSUER_FUNDING_XLM,
          })
        ),
        Operation.payment({
          destination: ctx.mmPublic,
          asset: Asset.native(),
          amount: returnAmount,
        }),
      ];
      return buildSignSubmit(ctx.demo, ops);
    }

    case "TRUST_AIRDROP1":
      return buildSignSubmit(ctx.demo, [
        Operation.changeTrust({ asset: resolveAsset("AIRDROP1", ctx) }),
      ]);

    case "TRUST_RUGPULL":
      return buildSignSubmit(ctx.demo, [
        Operation.changeTrust({ asset: resolveAsset("RUGPULL", ctx) }),
      ]);

    case "TRUST_LWDEMO":
      return buildSignSubmit(ctx.demo, [
        Operation.changeTrust({ asset: resolveAsset(LWDEMO_CODE, ctx) }),
      ]);

    case "TRUST_USDC":
      return buildSignSubmit(ctx.demo, [
        Operation.changeTrust({ asset: resolveAsset("USDC", ctx) }),
      ]);

    case "TRUST_EURC":
      return buildSignSubmit(ctx.demo, [
        Operation.changeTrust({ asset: resolveAsset("EURC", ctx) }),
      ]);

    case "FUND_RARE": {
      const assetsToFund = ctx.fundRareAssets;
      if (assetsToFund.length === 0) throw new Error("FUND_RARE called with no assets to fund");
      const ops = assetsToFund.map((code) => {
        const amount = code === "AIRDROP1" ? "1000000" : "13.37";
        return Operation.payment({
          source: ctx.ephemeralIssuers.get(code)!.publicKey(),
          destination: demoPublic,
          asset: resolveAsset(code, ctx),
          amount,
        });
      });
      const signers = assetsToFund.map((code) => ctx.ephemeralIssuers.get(code)!);
      return buildSignSubmit(ctx.demo, ops, signers);
    }

    case "FUND_LWDEMO":
      return buildSignSubmit(ctx.persistentIssuer, [
        Operation.payment({
          destination: demoPublic,
          asset: resolveAsset(LWDEMO_CODE, ctx),
          amount: LWDEMO_AMOUNT,
        }),
      ]);

    case "FUND_USDC": {
      const usdcIssuer = ctx.ephemeralIssuers.get("USDC")!;
      const usdcAsset = resolveAsset("USDC", ctx);
      const usdcCost = (parseFloat(USDC_DEMO_AMOUNT) * parseFloat(DEMO_SWAP_PRICE)).toFixed(7);
      return buildSignSubmit(
        ctx.demo,
        [
          Operation.manageSellOffer({
            source: usdcIssuer.publicKey(),
            selling: usdcAsset,
            buying: Asset.native(),
            amount: USDC_DEMO_AMOUNT,
            price: DEMO_SWAP_PRICE,
          }),
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax: usdcCost,
            destination: demoPublic,
            destAsset: usdcAsset,
            destAmount: USDC_DEMO_AMOUNT,
            path: [],
          }),
        ],
        [usdcIssuer]
      );
    }

    case "FUND_EURC": {
      const eurcIssuer = ctx.ephemeralIssuers.get("EURC")!;
      const eurcAsset = resolveAsset("EURC", ctx);
      const eurcCost = (parseFloat(EURC_DEMO_AMOUNT) * parseFloat(DEMO_SWAP_PRICE)).toFixed(7);
      return buildSignSubmit(
        ctx.demo,
        [
          Operation.manageSellOffer({
            source: eurcIssuer.publicKey(),
            selling: eurcAsset,
            buying: Asset.native(),
            amount: EURC_DEMO_AMOUNT,
            price: DEMO_SWAP_PRICE,
          }),
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax: eurcCost,
            destination: demoPublic,
            destAsset: eurcAsset,
            destAmount: EURC_DEMO_AMOUNT,
            path: [],
          }),
        ],
        [eurcIssuer]
      );
    }

    case "DATA_ENTRIES": {
      const count = Math.min(ctx.dataEntryCount, JUNK_DATA_ENTRIES.length);
      return buildSignSubmit(
        ctx.demo,
        JUNK_DATA_ENTRIES.slice(0, count).map(({ key, value }) =>
          Operation.manageData({ name: key, value })
        )
      );
    }

    case "OFFERS": {
      const count = Math.min(ctx.offerCount, JUNK_OFFERS.length);
      return buildSignSubmit(
        ctx.demo,
        JUNK_OFFERS.slice(0, count).map((o) =>
          Operation.manageSellOffer({
            selling: resolveAsset(o.selling, ctx),
            buying: resolveAsset(o.buying, ctx),
            amount: o.amount,
            price: o.price,
          })
        )
      );
    }

    case "ADD_SIGNER": {
      // The extra signer's secret is discarded: weight 1 with thresholds 0/1/1
      // never blocks the master key, and the demolish removes it anyway.
      const forgotten = Keypair.random();
      return buildSignSubmit(ctx.demo, [
        Operation.setOptions({ signer: { ed25519PublicKey: forgotten.publicKey(), weight: 1 } }),
      ]);
    }
  }
}
