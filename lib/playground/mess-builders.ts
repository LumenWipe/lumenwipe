import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";
import { TxSubmitError } from "@/lib/utils/errors";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  ACCOUNT_VISIBILITY_DELAY_MS,
  ACCOUNT_VISIBILITY_MAX_ATTEMPTS,
  BAD_SEQ_MAX_ATTEMPTS,
  BAD_SEQ_RETRY_DELAY_MS,
  TX_TIMEOUT_SECONDS,
} from "@/config/constants";
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

// Server-only: builds, signs and submits one real testnet transaction per
// mess step. Secrets only ever exist in memory inside the route handler.

export interface MessContext {
  demo: Keypair;
  /** asset code -> issuer keypair, populated from the session after SETUP */
  ephemeralIssuers: Map<string, Keypair>;
  persistentIssuer: Keypair;
  mmPublic: string;
  /** Subset of ephemeral codes to fund in FUND_RARE (varies by mode). */
  fundRareAssets: string[];
  /** How many junk offers to post (≤ JUNK_OFFERS.length). */
  offerCount: number;
  /** How many junk data entries to attach (≤ JUNK_DATA_ENTRIES.length). */
  dataEntryCount: number;
}

const PASSPHRASE = NETWORK_PASSPHRASES.testnet;

function resolveAsset(code: string, ctx: MessContext): Asset {
  if (code === "native") return Asset.native();
  if (code === LWDEMO_CODE) return new Asset(LWDEMO_CODE, ctx.persistentIssuer.publicKey());
  const issuer = ctx.ephemeralIssuers.get(code);
  if (!issuer) throw new Error(`Ephemeral issuer for ${code} not found in session`);
  return new Asset(code, issuer.publicKey());
}

const isAccountNotFound = (err: unknown): boolean =>
  /account not found/i.test(err instanceof Error ? err.message : String(err));

/**
 * getAccount, but tolerant of Soroban RPC ingestion lag. A freshly friendbot-funded
 * account (or one whose latest tx just confirmed) can briefly read back as "Account
 * not found" while the RPC catches up to the ledger. Retry that transient case with a
 * fixed backoff; surface any other error immediately. Generic over the fetch result so
 * it stays unit-testable without a live RPC server.
 */
export async function loadAccountWithRetry<T>(
  fetchAccount: (address: string) => Promise<T>,
  address: string,
  opts: {
    attempts?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
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
  const server = getRpcServer("testnet");
  const loadAccount = deps.loadAccount ?? ((address: string) => server.getAccount(address));
  const submit = deps.submit ?? ((signedXdr: string) => submitAndWait(signedXdr, "testnet"));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 0; attempt < BAD_SEQ_MAX_ATTEMPTS; attempt++) {
    // Re-read the source account on every attempt. The Soroban RPC can serve a
    // sequence number that lags the previously confirmed tx, which the network
    // then rejects as tx_bad_seq; a fresh read after a short wait picks up the
    // advanced sequence. (loadAccountWithRetry also covers the not-yet-ingested
    // "account not found" case for the very first read.)
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
      const isBadSeq = err instanceof TxSubmitError && err.resultCode === "tx_bad_seq";
      if (isBadSeq && attempt < BAD_SEQ_MAX_ATTEMPTS - 1) {
        await sleep(BAD_SEQ_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Self-healing liquidity: makes sure the market maker has its sell-XLM /
 * buy-LWDEMO offer posted (the counterparty for the demo's DEX conversion).
 * Non-fatal on failure - the demo degrades to the send-to-issuer fallback.
 */
export async function ensureMmOffer(mm: Keypair, issuerPublic: string): Promise<void> {
  const { getLiveAccountState } = await import("@/lib/stellar/account-live");
  const state = await getLiveAccountState(mm.publicKey());
  const lwdemoAsset = `${LWDEMO_CODE}:${issuerPublic}`;
  if (state.openOffers.some((o) => o.selling === "native" && o.buying === lwdemoAsset)) return;

  const spendable = parseFloat(state.nativeBalanceLumens) - 10;
  const amount = Math.min(spendable, 5000);
  if (amount < 50) {
    console.error(
      `[playground] MM ${mm.publicKey()} balance too low to post liquidity offer ` +
        `(${state.nativeBalanceLumens} XLM) - DEX conversion will fall back to send-to-issuer`
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
      // Create all ephemeral issuer accounts needed for this session's mode.
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
      // Fund each "rare" ephemeral asset in one atomic tx. The server holds all
      // ephemeral secrets so it can source each payment from the right issuer.
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
      // Atomic DEX swap: issuer posts a sell offer; demo crosses it immediately
      // with a pathPaymentStrictReceive in the same transaction.  Demo spends
      // XLM and receives USDC via the order book - same mechanism as the real
      // CONVERT_ASSETS step, just in the opposite direction.
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
        Operation.setOptions({
          signer: { ed25519PublicKey: forgotten.publicKey(), weight: 1 },
        }),
      ]);
    }
  }
}
