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
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { TX_TIMEOUT_SECONDS } from "@/config/constants";
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

export async function buildSignSubmit(
  sourceKeypair: Keypair,
  ops: xdr.Operation[],
  extraSigners: Keypair[] = []
): Promise<string> {
  const server = getRpcServer("testnet");
  const live = await server.getAccount(sourceKeypair.publicKey());
  const account = new Account(sourceKeypair.publicKey(), live.sequenceNumber());

  const builder = new TransactionBuilder(account, {
    fee: String(100 * Math.max(ops.length, 1) * 2),
    networkPassphrase: PASSPHRASE,
  }).setTimeout(TX_TIMEOUT_SECONDS);
  ops.forEach((op) => builder.addOperation(op));

  const tx = builder.build();
  tx.sign(sourceKeypair, ...extraSigners);

  const { txHash } = await submitAndWait(tx.toEnvelope().toXDR("base64"), "testnet");
  return txHash;
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
