import { formatStroops, parseStroops } from "../stroops";
import { BASE_RESERVE_XLM } from "./catalog";
import { MESS_STEP_SECONDS, ORDER } from "./definitions";
import { PINNED_ASSETS, type PinnedAssetId } from "./pinned";
import type { MessStepDef, MessStepId, OrderedStep, ScenarioBuild } from "./types";

// What several scenarios need and the plan provides once: a pinned asset bought on the testnet
// DEX. A scenario's step says what it spends (`spendsPinned`); the resolver adds one trustline and
// one purchase per asset for everything the selection spends, so two pools that both pair Circle's
// USDC never open the trustline twice or race each other's purchase.
//
// The registry's rule that every step id has one owner still holds: these step ids belong to the
// resolver (`PURCHASE_OWNER`), and a scenario that declared one itself would be refused as an
// unsupported combination the moment its plan was resolved.

/** The owner of the shared purchase steps, in the registry's one-owner-per-step-id rule. */
export const PURCHASE_OWNER = "pinned-purchase";

const PURCHASE_STEPS: Readonly<Record<PinnedAssetId, { trust: MessStepId; buy: MessStepId }>> = {
  "circle-usdc": { trust: "TRUST_CIRCLE_USDC", buy: "BUY_CIRCLE_USDC" },
};

/** The scene node of a pinned asset's trustline, named for the asset, never a playground code. */
export const pinnedNodeId = (asset: PinnedAssetId): string => `tl:${asset}`;

/** An amount as the plan shows it: no trailing zeros, so "2", not "2.0000000". */
const amountText = (stroops: bigint): string =>
  formatStroops(stroops).replace(/0+$/, "").replace(/\.$/, "");

function stroopsOf(amount: string): bigint {
  const stroops = parseStroops(amount);
  if (stroops === null) throw new Error(`An unreadable pinned amount: ${amount}`);
  return stroops;
}

/** Per pinned asset, what the steps spend in total and the sum of their ceilings, in stroops. */
function totals(
  steps: readonly MessStepDef[]
): Map<PinnedAssetId, { amount: bigint; maxXlm: bigint }> {
  const byAsset = new Map<PinnedAssetId, { amount: bigint; maxXlm: bigint }>();
  for (const { spendsPinned: spend } of steps) {
    if (!spend) continue;
    const sum = byAsset.get(spend.asset) ?? { amount: BigInt(0), maxXlm: BigInt(0) };
    byAsset.set(spend.asset, {
      amount: sum.amount + stroopsOf(spend.amount),
      maxXlm: sum.maxXlm + stroopsOf(spend.maxXlm),
    });
  }
  return byAsset;
}

/**
 * The trustline and the purchase the steps' spending needs, one of each per pinned asset, for the
 * total they spend within the sum of their ceilings: the ceiling grows with the selection, so
 * every scenario keeps the margin it was given. Null when no step spends a pinned asset.
 */
export function purchaseBuild(steps: readonly MessStepDef[]): ScenarioBuild | null {
  const byAsset = totals(steps);
  if (byAsset.size === 0) return null;
  const ordered: OrderedStep[] = [];
  let xlm = 0;
  for (const [asset, sum] of byAsset) {
    const { label } = PINNED_ASSETS[asset];
    const ids = PURCHASE_STEPS[asset];
    const nodeId = pinnedNodeId(asset);
    const amount = amountText(sum.amount);
    const maxXlm = amountText(sum.maxXlm);
    ordered.push(
      {
        order: ORDER.trust + 9,
        step: {
          id: ids.trust,
          label: `Open ${label} trustline`,
          nodes: [{ id: nodeId, kind: "trustline", label }],
          balances: [],
          action: { kind: "pinned_trust", asset, amount, maxXlm },
        },
      },
      {
        order: ORDER.fund + 9,
        step: {
          id: ids.buy,
          label: `Buy ${amount} ${label} with XLM on the DEX`,
          nodes: [],
          balances: [{ nodeId, balance: amount }],
          action: { kind: "pinned_buy", asset, amount, maxXlm },
        },
      }
    );
    // The trustline's reserve and the most the purchase may spend.
    xlm += BASE_RESERVE_XLM + Number(maxXlm);
  }
  const assets = byAsset.size;
  return {
    steps: ordered,
    ephemeralAssets: [],
    expectation: {
      // A pinned asset is not a playground code: the verifier adds it from the plan's steps.
      assets: [],
      offers: 0,
      dataEntries: 0,
      signers: 0,
      // What the exits pay back returns to its issuer, then the trustline goes.
      closeOperations: 2 * assets,
      operationTypes: ["payment", "changeTrust"],
      dispositions: [],
      arrivingAssets: [],
      sponsoredEntries: [],
      resolutions: [],
    },
    cost: {
      xlm,
      classicTransactions: 2 * assets,
      sorobanTransactions: 0,
      seconds: 2 * assets * MESS_STEP_SECONDS,
      subEntries: assets,
    },
  };
}

/** The steps, in plan order, each spending step showing the trustline balance it leaves. */
export function withPinnedBalances(steps: readonly MessStepDef[]): MessStepDef[] {
  const left = new Map([...totals(steps)].map(([asset, sum]) => [asset, sum.amount]));
  return steps.map((step) => {
    const spend = step.spendsPinned;
    if (!spend) return step;
    const remaining = (left.get(spend.asset) ?? BigInt(0)) - stroopsOf(spend.amount);
    left.set(spend.asset, remaining);
    return {
      ...step,
      balances: [
        ...step.balances,
        { nodeId: pinnedNodeId(spend.asset), balance: amountText(remaining) },
      ],
    };
  });
}
