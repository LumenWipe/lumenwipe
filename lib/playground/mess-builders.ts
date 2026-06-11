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
  EPHEMERAL_ASSETS,
  EPHEMERAL_ISSUER_FUNDING_XLM,
  JUNK_DATA_ENTRIES,
  JUNK_OFFERS,
  LWDEMO_AMOUNT,
  LWDEMO_CODE,
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
      const returnAmount = String(10000 - parseFloat(DEMO_KEEP_XLM));
      const ops = [
        ...EPHEMERAL_ASSETS.map(({ code }) =>
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

    case "FUND_RARE": {
      // One tx, source = demo, payment ops sourced from each ephemeral issuer:
      // the server holds all three secrets, so it can multi-sign.
      const ops = EPHEMERAL_ASSETS.map(({ code, amount }) =>
        Operation.payment({
          source: ctx.ephemeralIssuers.get(code)!.publicKey(),
          destination: demoPublic,
          asset: resolveAsset(code, ctx),
          amount,
        })
      );
      return buildSignSubmit(ctx.demo, ops, [...ctx.ephemeralIssuers.values()]);
    }

    case "FUND_LWDEMO":
      return buildSignSubmit(ctx.persistentIssuer, [
        Operation.payment({
          destination: demoPublic,
          asset: resolveAsset(LWDEMO_CODE, ctx),
          amount: LWDEMO_AMOUNT,
        }),
      ]);

    case "DATA_ENTRIES":
      return buildSignSubmit(
        ctx.demo,
        JUNK_DATA_ENTRIES.map(({ key, value }) => Operation.manageData({ name: key, value }))
      );

    case "OFFERS":
      return buildSignSubmit(
        ctx.demo,
        JUNK_OFFERS.map((o) =>
          Operation.manageSellOffer({
            selling: resolveAsset(o.selling, ctx),
            buying: resolveAsset(o.buying, ctx),
            amount: o.amount,
            price: o.price,
          })
        )
      );

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
