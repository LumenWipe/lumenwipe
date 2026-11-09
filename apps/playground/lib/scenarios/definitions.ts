import {
  AIRDROP_ASSETS,
  BASE_RESERVE_XLM,
  DEMO_SWAP_PRICE,
  EPHEMERAL_ISSUER_FUNDING_XLM,
  JUNK_DATA_ENTRIES,
  JUNK_OFFERS,
  LWDEMO_AMOUNT,
  LWDEMO_CODE,
  SWAP_ASSETS,
  type AssetCode,
  type OfferAsset,
} from "./catalog";
import type {
  MessStepDef,
  MessStepId,
  OrderedStep,
  ScenarioCost,
  ScenarioDefinition,
} from "./types";

export const MESS_STEP_SECONDS = 5;
export const CLOSE_GROUP_SECONDS = 8;

const ISSUER_FUNDING = Number(EPHEMERAL_ISSUER_FUNDING_XLM);

export const ORDER = { setup: 0, trust: 10, fund: 20, data: 30, offers: 40, signers: 90 } as const;

const TRUST_STEP: Record<AssetCode, MessStepId> = {
  AIRDROP1: "TRUST_AIRDROP1",
  RUGPULL: "TRUST_RUGPULL",
  LWDEMO: "TRUST_LWDEMO",
  USDC: "TRUST_USDC",
  EURC: "TRUST_EURC",
};

/** Trustlines open in this order, so the offers that need them line up with the catalog. */
const TRUST_ORDER: readonly AssetCode[] = ["AIRDROP1", "RUGPULL", "LWDEMO", "USDC", "EURC"];

const trustlineNode = (code: AssetCode): string => `tl:${code}`;

function trustStep(code: AssetCode): OrderedStep {
  return {
    order: ORDER.trust + TRUST_ORDER.indexOf(code),
    step: {
      id: TRUST_STEP[code],
      label: `Open ${code} trustline`,
      nodes: [{ id: trustlineNode(code), kind: "trustline", label: code }],
      balances: [],
      action: { kind: "change_trust", asset: code },
    },
  };
}

function cost(steps: number, closeGroups: number, xlm: number, subEntries: number): ScenarioCost {
  return {
    xlm,
    classicTransactions: steps,
    sorobanTransactions: 0,
    seconds: steps * MESS_STEP_SECONDS + closeGroups * CLOSE_GROUP_SECONDS,
    batchSize: 1,
    subEntries,
  };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const offerAssetLabel = (asset: OfferAsset): string => (asset === "native" ? "XLM" : asset);

const lwdemoHolding: ScenarioDefinition = {
  id: "lwdemo-holding",
  featureSet: "classic",
  label: "Demo token holding",
  description: "A trustline to the playground's own token, with a balance to return.",
  params: {},
  heldAssets: () => [LWDEMO_CODE],
  requiresAnyOf: [],
  conflicts: [],
  build: () => ({
    ok: true,
    build: {
      steps: [
        trustStep(LWDEMO_CODE),
        {
          order: ORDER.fund + 1,
          step: {
            id: "FUND_LWDEMO",
            label: `Receive ${LWDEMO_AMOUNT} ${LWDEMO_CODE}`,
            nodes: [],
            balances: [{ nodeId: trustlineNode(LWDEMO_CODE), balance: LWDEMO_AMOUNT }],
            action: { kind: "issuer_payment", asset: LWDEMO_CODE, amount: LWDEMO_AMOUNT },
          },
        },
      ],
      ephemeralAssets: [],
      expectation: {
        assets: [LWDEMO_CODE],
        offers: 0,
        dataEntries: 0,
        signers: 0,
        closeOperations: 2,
        operationTypes: ["payment", "changeTrust"],
      },
      cost: cost(2, 1, BASE_RESERVE_XLM, 1),
    },
  }),
};

const junkAirdrops: ScenarioDefinition = {
  id: "junk-airdrops",
  featureSet: "classic",
  label: "Junk airdrops",
  description: "Unsolicited tokens from throwaway issuers, each on its own trustline.",
  params: { tokens: { label: "Tokens", min: 1, max: AIRDROP_ASSETS.length, default: 2 } },
  heldAssets: ({ tokens }) => AIRDROP_ASSETS.slice(0, tokens).map((a) => a.code),
  requiresAnyOf: [],
  conflicts: [],
  build: ({ tokens }) => {
    const assets = AIRDROP_ASSETS.slice(0, tokens);
    const codes = assets.map((a) => a.code);
    return {
      ok: true,
      build: {
        steps: [
          ...codes.map(trustStep),
          {
            order: ORDER.fund,
            step: {
              id: "FUND_RARE",
              label: "Receive junk token airdrops",
              nodes: [],
              balances: assets.map((a) => ({ nodeId: trustlineNode(a.code), balance: a.amount })),
              action: {
                kind: "airdrops",
                payments: assets.map((a) => ({ asset: a.code, amount: a.amount })),
              },
            },
          },
        ],
        ephemeralAssets: codes,
        expectation: {
          assets: codes,
          offers: 0,
          dataEntries: 0,
          signers: 0,
          closeOperations: 2 * tokens,
          operationTypes: ["payment", "changeTrust"],
        },
        cost: cost(tokens + 1, tokens, tokens * (ISSUER_FUNDING + BASE_RESERVE_XLM), tokens),
      },
    };
  },
};

const FUND_SWAP_STEP: Record<(typeof SWAP_ASSETS)[number]["code"], MessStepId> = {
  USDC: "FUND_USDC",
  EURC: "FUND_EURC",
};

const stablecoinSwaps: ScenarioDefinition = {
  id: "stablecoin-swaps",
  featureSet: "classic",
  label: "Stablecoin swaps",
  description: "Stablecoins bought with XLM on the DEX, left sitting on their trustlines.",
  params: { tokens: { label: "Tokens", min: 1, max: SWAP_ASSETS.length, default: 2 } },
  heldAssets: ({ tokens }) => SWAP_ASSETS.slice(0, tokens).map((a) => a.code),
  requiresAnyOf: [],
  conflicts: [],
  build: ({ tokens }) => {
    const assets = SWAP_ASSETS.slice(0, tokens);
    const codes = assets.map((a) => a.code);
    const swapXlm = assets.reduce((sum, a) => sum + Number(a.amount) * Number(DEMO_SWAP_PRICE), 0);
    const steps: OrderedStep[] = [...codes.map(trustStep)];
    assets.forEach((a, i) => {
      const step: MessStepDef = {
        id: FUND_SWAP_STEP[a.code],
        label: `Swap XLM → ${a.amount} ${a.code} on the DEX`,
        nodes: [],
        balances: [{ nodeId: trustlineNode(a.code), balance: a.amount }],
        action: { kind: "dex_swap", asset: a.code, amount: a.amount, price: DEMO_SWAP_PRICE },
      };
      steps.push({ order: ORDER.fund + 2 + i, step });
    });
    return {
      ok: true,
      build: {
        steps,
        ephemeralAssets: codes,
        expectation: {
          assets: codes,
          offers: 0,
          dataEntries: 0,
          signers: 0,
          closeOperations: 2 * tokens,
          operationTypes: ["payment", "changeTrust"],
        },
        cost: cost(
          2 * tokens,
          tokens,
          tokens * (ISSUER_FUNDING + BASE_RESERVE_XLM) + swapXlm,
          tokens
        ),
      },
    };
  },
};

const dataEntries: ScenarioDefinition = {
  id: "data-entries",
  featureSet: "classic",
  label: "Leftover data entries",
  description: "Key-value entries an old app attached to the account.",
  params: { count: { label: "Entries", min: 1, max: JUNK_DATA_ENTRIES.length, default: 3 } },
  heldAssets: () => [],
  requiresAnyOf: [],
  conflicts: [],
  build: ({ count }) => {
    const entries = JUNK_DATA_ENTRIES.slice(0, count).map(({ key, value }) => ({ key, value }));
    return {
      ok: true,
      build: {
        steps: [
          {
            order: ORDER.data,
            step: {
              id: "DATA_ENTRIES",
              label: `Attach ${count} leftover ${plural(count, "data entry", "data entries")}`,
              nodes: entries.map((e) => ({ id: `data:${e.key}`, kind: "data", label: e.key })),
              balances: [],
              action: { kind: "manage_data", entries },
            },
          },
        ],
        ephemeralAssets: [],
        expectation: {
          assets: [],
          offers: 0,
          dataEntries: count,
          signers: 0,
          closeOperations: count,
          operationTypes: ["manageData"],
        },
        cost: cost(1, 1, count * BASE_RESERVE_XLM, count),
      },
    };
  },
};

const staleOffers: ScenarioDefinition = {
  id: "stale-offers",
  featureSet: "classic",
  label: "Stale DEX offers",
  description: "Open offers that tie up balances, each on a pair the account holds.",
  params: { count: { label: "Offers", min: 1, max: JUNK_OFFERS.length, default: 3 } },
  heldAssets: () => [],
  requiresAnyOf: ["lwdemo-holding", "junk-airdrops", "stablecoin-swaps"],
  conflicts: [],
  build: ({ count }, { heldAssets }) => {
    const held = (asset: OfferAsset): boolean =>
      asset === "native" || heldAssets.some((code) => code === asset);
    const eligible = JUNK_OFFERS.map((offer, index) => ({ offer, index })).filter(
      ({ offer }) => held(offer.selling) && held(offer.buying)
    );
    if (count > eligible.length) {
      return {
        ok: false,
        message: `Stale DEX offers can post at most ${eligible.length} ${plural(eligible.length, "offer", "offers")} with the selected tokens: each offer trades a token the account holds.`,
      };
    }
    const chosen = eligible.slice(0, count);
    const lockedXlm = chosen.reduce(
      (sum, { offer }) => sum + (offer.selling === "native" ? Number(offer.amount) : 0),
      0
    );
    return {
      ok: true,
      build: {
        steps: [
          {
            order: ORDER.offers,
            step: {
              id: "OFFERS",
              label: `Post ${count} stale DEX ${plural(count, "offer", "offers")}`,
              nodes: chosen.map(({ offer, index }) => ({
                id: `offer:${index}`,
                kind: "offer",
                label: `Sell ${offerAssetLabel(offer.selling)} → ${offerAssetLabel(offer.buying)}`,
                offer: { selling: offer.selling, buying: offer.buying },
              })),
              balances: [],
              action: {
                kind: "offers",
                offers: chosen.map(({ offer }) => ({
                  selling: offer.selling,
                  buying: offer.buying,
                  amount: offer.amount,
                  price: offer.price,
                })),
              },
            },
          },
        ],
        ephemeralAssets: [],
        expectation: {
          assets: [],
          offers: count,
          dataEntries: 0,
          signers: 0,
          closeOperations: count,
          operationTypes: ["manageSellOffer"],
        },
        cost: cost(1, 1, count * BASE_RESERVE_XLM + lockedXlm, count),
      },
    };
  },
};

const forgottenSigner: ScenarioDefinition = {
  id: "forgotten-signer",
  featureSet: "classic",
  label: "Forgotten co-signer",
  description: "An extra signer whose key nobody kept, which the close must remove.",
  params: {},
  heldAssets: () => [],
  requiresAnyOf: [],
  conflicts: [],
  build: () => ({
    ok: true,
    build: {
      steps: [
        {
          order: ORDER.signers,
          step: {
            id: "ADD_SIGNER",
            label: "Add a forgotten co-signer",
            nodes: [{ id: "signer:extra", kind: "signer", label: "Forgotten co-signer" }],
            balances: [],
            action: { kind: "add_signer" },
          },
        },
      ],
      ephemeralAssets: [],
      expectation: {
        assets: [],
        offers: 0,
        dataEntries: 0,
        signers: 1,
        closeOperations: 1,
        operationTypes: ["setOptions"],
      },
      cost: cost(1, 1, BASE_RESERVE_XLM, 1),
    },
  }),
};

/** Every scenario, in the order a selection lists them. */
export const SCENARIOS: readonly ScenarioDefinition[] = [
  lwdemoHolding,
  junkAirdrops,
  stablecoinSwaps,
  dataEntries,
  staleOffers,
  forgottenSigner,
];
