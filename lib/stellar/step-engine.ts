import { Account, Asset } from "@stellar/stellar-sdk";
import { getMediatorPublicKey, type Network } from "@/config/networks";
import { getRpcServer, getTrustlineEntry } from "@/lib/stellar/rpc";
import { NoConversionPathError } from "@/lib/utils/errors";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { buildRemoveDataEntriesTx } from "@/lib/stellar/tx-builder/data-entries";
import { buildCancelOffersTx } from "@/lib/stellar/tx-builder/offers";
import {
  buildConvertAssetTx,
  buildSendToIssuerTx,
} from "@/lib/stellar/tx-builder/asset-conversion";
import { buildRemoveTrustlinesTx } from "@/lib/stellar/tx-builder/trustlines";
import { buildNormalizeSignersTx } from "@/lib/stellar/tx-builder/signers";
import { buildMergeTx, buildMediatorMergePaymentTx } from "@/lib/stellar/tx-builder/merge";
import { batchItems } from "@/lib/stellar/tx-builder/batching";
import type { AccountState, Trustline } from "@/types/account";
import type { PlannedStep } from "@/types/plan";

// Engine core shared by the wallet flow (useStepExecution) and the testnet
// playground (usePlaygroundExecution). Pure with respect to React: all state
// comes in through the context object.

export interface StepBuildContext {
  network: Network;
  sourceAddress: string;
  accountState: AccountState;
  destinationAddress: string;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  mediatorRequired: boolean;
  executionPlan: PlannedStep[];
}

/** Signs an unsigned XDR and returns the signed envelope (local key or remote API). */
export type StepSigner = (unsignedXdr: string) => Promise<string>;

export async function fetchLiveTrustlineBalance(
  tl: Trustline,
  accountAddress: string,
  server: ReturnType<typeof getRpcServer>
): Promise<string> {
  try {
    const asset = new Asset(tl.code, tl.issuer);
    const entry = await getTrustlineEntry(server, accountAddress, asset);
    if (!entry) return tl.balance;
    return stroopsToXlm(BigInt(entry.balance().toString()));
  } catch {
    return tl.balance;
  }
}

export function getBatchIndex(step: PlannedStep, type: string, plan: PlannedStep[]): number {
  const stepsOfType = plan.filter((s) => s.type === type);
  return stepsOfType.findIndex((s) => s.index === step.index);
}

/** Builds the unsigned XDR for a planned step using the current on-chain sequence. */
export async function buildStepXdrForPlan(
  step: PlannedStep,
  ctx: StepBuildContext
): Promise<string> {
  const { network, sourceAddress, accountState, destinationAddress, memo, memoType } = ctx;

  const server = getRpcServer(network);
  const liveAccount = await server.getAccount(sourceAddress);
  const sdkAccount = new Account(sourceAddress, liveAccount.sequenceNumber());

  const { dataEntries, openOffers, trustlines, signers } = accountState;

  switch (step.type) {
    case "NORMALIZE_SIGNERS": {
      const extras = signers.filter((s) => s.key !== sourceAddress);
      return buildNormalizeSignersTx(sdkAccount, extras, network);
    }

    case "REMOVE_DATA_ENTRIES": {
      const batches = batchItems(dataEntries, 100);
      const batchIdx = getBatchIndex(step, "REMOVE_DATA_ENTRIES", ctx.executionPlan);
      return buildRemoveDataEntriesTx(sdkAccount, batches[batchIdx] ?? dataEntries, network);
    }

    case "CANCEL_OFFERS": {
      const batches = batchItems(openOffers, 100);
      const batchIdx = getBatchIndex(step, "CANCEL_OFFERS", ctx.executionPlan);
      return buildCancelOffersTx(sdkAccount, batches[batchIdx] ?? openOffers, network);
    }

    case "CONVERT_ASSETS": {
      const tl = trustlines.find((t) => t.asset === step.affectedAsset);
      if (!tl) throw new Error(`Trustline not found: ${step.affectedAsset}`);
      const liveBalance = await fetchLiveTrustlineBalance(tl, sourceAddress, server);
      const effectiveTl = { ...tl, balance: liveBalance };
      if (step.fallbackToIssuer) {
        return buildSendToIssuerTx(sdkAccount, effectiveTl, network);
      }
      const path = await fetchConversionPath(effectiveTl.asset, effectiveTl.balance, network);
      if (!path) throw new NoConversionPathError(tl.code);
      return buildConvertAssetTx(sdkAccount, effectiveTl, path, network);
    }

    case "REMOVE_TRUSTLINES": {
      const batches = batchItems(trustlines, 100);
      const batchIdx = getBatchIndex(step, "REMOVE_TRUSTLINES", ctx.executionPlan);
      return buildRemoveTrustlinesTx(sdkAccount, batches[batchIdx] ?? trustlines, network);
    }

    case "MERGE": {
      if (ctx.mediatorRequired) {
        const mediator = getMediatorPublicKey(network);
        if (!mediator) {
          throw new Error(
            "This destination needs the exchange (mediator) flow, but no shared mediator account is configured on this deployment."
          );
        }
        // Forward essentially the full live balance through the shared mediator.
        const res = await fetch(`/api/${network}/account/${sourceAddress}`);
        if (!res.ok) {
          throw new Error("Could not read the account balance to build the merge.");
        }
        const live = (await res.json()) as { nativeBalanceLumens: string };
        return buildMediatorMergePaymentTx(
          sdkAccount,
          mediator,
          destinationAddress,
          live.nativeBalanceLumens,
          memo,
          network,
          memoType
        );
      }
      return buildMergeTx(sdkAccount, destinationAddress, memo, network, memoType);
    }

    default:
      throw new Error(`Unknown step type: ${step.type}`);
  }
}
