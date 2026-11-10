import {
  AIRDROP_ASSETS,
  BASE_FEE_XLM,
  BASE_RESERVE_XLM,
  DEMO_SWAP_PRICE,
  DISPOSITION_ASSETS,
  EPHEMERAL_ISSUER_FUNDING_XLM,
  JUNK_DATA_ENTRIES,
  JUNK_OFFERS,
  LWDEMO_AMOUNT,
  LWDEMO_CODE,
  RECIPIENT_FUNDING_XLM,
  BENEFICIARY_DATA_ENTRY,
  BENEFICIARY_FUNDING_XLM,
  CLAIM_BONUS_AMOUNT,
  CLAIM_GIFT_AMOUNT,
  CLAIMANT_FUNDING_XLM,
  DEMO_SPONSORED_CLAIM_XLM,
  SPONSOR_FUNDING_XLM,
  SPONSORED_DATA_ENTRY,
  SPONSORED_OFFER,
  MULTISIG_SIGNER_WEIGHT,
  MULTISIG_THRESHOLD,
  TIME_GATED_AMOUNT,
  UNREVOCABLE_BENEFICIARY_FUNDING_XLM,
  SWAP_ASSETS,
  type AssetCode,
  type OfferAsset,
} from "./catalog";
import { AQUARIUS_SEED, BLEND_SEED, SOROSWAP_SEED } from "./pinned";
import {
  DISPOSITION_CHOICES,
  type AssetDisposition,
  type BlendVariant,
  type ClaimableBalanceSpec,
  type SponsorshipVariant,
  type CloseOperationType,
  type DispositionChoice,
  type MessStepDef,
  type MessStepId,
  type MultisigVariant,
  type OrderedStep,
  type SceneNodeSpec,
  type ScenarioCost,
  type ScenarioDefinition,
  type ScenarioId,
  type StepAction,
} from "./types";

export const MESS_STEP_SECONDS = 5;
export const CLOSE_GROUP_SECONDS = 8;

const ISSUER_FUNDING = Number(EPHEMERAL_ISSUER_FUNDING_XLM);

export const ORDER = {
  setup: 0,
  trust: 10,
  fund: 20,
  data: 30,
  offers: 40,
  claims: 50,
  sponsorships: 60,
  /** Protocol positions, after every trustline and balance they are built from. */
  protocol: 70,
  signers: 90,
  /** Last: once the thresholds are raised the master key alone cannot sign another step. */
  multisig: 95,
} as const;

/** The assets the demo opens a trustline to during the mess; the others arrive in the close or
 *  belong to a helper. */
const TRUST_STEP: Partial<Record<AssetCode, MessStepId>> = {
  AIRDROP1: "TRUST_AIRDROP1",
  RUGPULL: "TRUST_RUGPULL",
  LWDEMO: "TRUST_LWDEMO",
  USDC: "TRUST_USDC",
  EURC: "TRUST_EURC",
  LWCOIN: "TRUST_LWCOIN",
  LWGEM: "TRUST_LWGEM",
  BONUS: "TRUST_BONUS",
};

/** Trustlines open in this order, so the offers that need them line up with the catalog. */
const TRUST_ORDER: readonly AssetCode[] = [
  "AIRDROP1",
  "RUGPULL",
  "LWDEMO",
  "USDC",
  "EURC",
  "LWCOIN",
  "LWGEM",
  "BONUS",
];

const trustlineNode = (code: AssetCode): string => `tl:${code}`;

function trustStep(code: AssetCode): OrderedStep {
  const id = TRUST_STEP[code];
  if (!id) throw new Error(`No trust step for ${code}`);
  return {
    order: ORDER.trust + TRUST_ORDER.indexOf(code),
    step: {
      id,
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
        dispositions: [],
        arrivingAssets: [],
        sponsoredEntries: [],
        resolutions: [],
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
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
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
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
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
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
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
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
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
        dispositions: [],
        arrivingAssets: [],
        sponsoredEntries: [],
        resolutions: [],
      },
      cost: cost(1, 1, BASE_RESERVE_XLM, 1),
    },
  }),
};

const FUND_DISPOSITION_STEP: Record<(typeof DISPOSITION_ASSETS)[number]["code"], MessStepId> = {
  LWCOIN: "FUND_LWCOIN",
  LWGEM: "FUND_LWGEM",
};

const CHOICE_LABELS: Record<DispositionChoice, string> = {
  burn: "Burn (return to issuer)",
  convert: "Convert to XLM",
  transfer: "Transfer to another account",
};

/** The parameter for each asset is its code in lower case, valued by DISPOSITION_CHOICES' index. */
const dispositionParam = (code: string): string => code.toLowerCase();

function chosenDispositions(params: Readonly<Record<string, number>>): AssetDisposition[] {
  return DISPOSITION_ASSETS.map((a) => {
    const choice = DISPOSITION_CHOICES[params[dispositionParam(a.code)] ?? 0];
    if (!choice) throw new RangeError(`No disposition at index for ${a.code}`);
    return { asset: a.code, choice, amount: a.amount };
  });
}

const dispositions: ScenarioDefinition = {
  id: "dispositions",
  featureSet: "classic",
  label: "Convert, transfer or burn",
  description:
    "Two playground tokens, each closed the way you pick: burned, converted to XLM, or sent to another account.",
  params: Object.fromEntries(
    DISPOSITION_ASSETS.map((a) => [
      dispositionParam(a.code),
      {
        label: a.code,
        min: 0,
        max: DISPOSITION_CHOICES.length - 1,
        default: 0,
        choices: DISPOSITION_CHOICES.map((c) => CHOICE_LABELS[c]),
      },
    ])
  ),
  heldAssets: () => DISPOSITION_ASSETS.map((a) => a.code),
  requiresAnyOf: [],
  conflicts: [],
  build: (params) => {
    const chosen = chosenDispositions(params);
    const codes = chosen.map((d) => d.asset);
    const transferred = chosen.filter((d) => d.choice === "transfer").map((d) => d.asset);
    const steps: OrderedStep[] = [...codes.map(trustStep)];
    DISPOSITION_ASSETS.forEach((a, i) => {
      steps.push({
        order: ORDER.fund + 4 + i,
        step: {
          id: FUND_DISPOSITION_STEP[a.code],
          label: `Receive ${a.amount} ${a.code}`,
          nodes: [],
          balances: [{ nodeId: trustlineNode(a.code), balance: a.amount }],
          action: { kind: "issuer_payment", asset: a.code, amount: a.amount },
        },
      });
    });
    if (transferred.length > 0) {
      steps.push({
        order: ORDER.fund + 4 + DISPOSITION_ASSETS.length,
        step: {
          id: "OPEN_RECIPIENT",
          label: `Open an account that can receive ${transferred.join(" and ")}`,
          nodes: [],
          balances: [],
          action: {
            kind: "open_recipient",
            fundingXlm: RECIPIENT_FUNDING_XLM,
            assets: transferred,
          },
        },
      });
    }
    const operationTypes: CloseOperationType[] = ["payment", "changeTrust"];
    if (chosen.some((d) => d.choice === "convert")) operationTypes.push("pathPaymentStrictSend");
    const recipientXlm = transferred.length > 0 ? Number(RECIPIENT_FUNDING_XLM) : 0;
    return {
      ok: true,
      build: {
        steps,
        ephemeralAssets: [],
        expectation: {
          assets: codes,
          offers: 0,
          dataEntries: 0,
          signers: 0,
          // A payment or a conversion, then the trustline removal, per asset.
          closeOperations: 2 * codes.length,
          operationTypes,
          dispositions: chosen.filter((d) => d.choice !== "burn"),
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
        },
        cost: cost(
          steps.length,
          codes.length,
          codes.length * BASE_RESERVE_XLM + recipientXlm,
          codes.length
        ),
      },
    };
  },
};

const ON_OFF = ["Off", "On"] as const;
const toggle = (label: string, on: boolean) => ({
  label,
  min: 0,
  max: 1,
  default: on ? 1 : 0,
  choices: ON_OFF,
});

const claimableBalances: ScenarioDefinition = {
  id: "claimable-balances",
  featureSet: "classic",
  label: "Claimable balances",
  description:
    "A balance waiting for the demo to claim, and optionally one that needs a trustline first, one locked past the session, and one the demo itself created, which blocks the merge until it is claimed.",
  params: {
    add_trustline: toggle("Needs a trustline", true),
    time_gated: toggle("Locked for two hours", false),
    demo_sponsored: toggle("Created by the demo", false),
  },
  heldAssets: () => ["BONUS"],
  requiresAnyOf: [],
  conflicts: [],
  build: ({ add_trustline, time_gated, demo_sponsored }) => {
    const balances: ClaimableBalanceSpec[] = [
      { asset: "BONUS", amount: CLAIM_BONUS_AMOUNT, intent: "claim" },
    ];
    if (add_trustline) {
      balances.push({
        asset: "GIFT",
        amount: CLAIM_GIFT_AMOUNT,
        intent: "add_trustline_then_claim",
      });
    }
    if (time_gated) balances.push({ asset: "BONUS", amount: TIME_GATED_AMOUNT, intent: "forfeit" });
    if (demo_sponsored) {
      balances.push({
        asset: "native",
        amount: DEMO_SPONSORED_CLAIM_XLM,
        intent: "demo_sponsored",
      });
    }
    const trusted: AssetCode[] = ["BONUS"];
    const arriving: AssetCode[] = add_trustline ? ["GIFT"] : [];
    const steps: OrderedStep[] = [
      ...trusted.map(trustStep),
      {
        order: ORDER.claims,
        step: {
          id: "CLAIMABLE_BALANCES",
          label: `Leave ${balances.length} claimable ${plural(balances.length, "balance", "balances")}`,
          nodes: [],
          balances: [],
          action: {
            kind: "claimable_balances",
            balances,
            claimantFundingXlm: CLAIMANT_FUNDING_XLM,
          },
        },
      },
    ];
    const issuers = [...new Set([...trusted, ...arriving])];
    const sponsoredXlm = demo_sponsored
      ? Number(DEMO_SPONSORED_CLAIM_XLM) + BASE_RESERVE_XLM + Number(CLAIMANT_FUNDING_XLM)
      : 0;
    return {
      ok: true,
      build: {
        steps,
        ephemeralAssets: issuers,
        expectation: {
          assets: trusted,
          offers: 0,
          dataEntries: 0,
          signers: 0,
          closeOperations: 2 * (trusted.length + arriving.length),
          operationTypes: ["payment", "changeTrust", "claimClaimableBalance"],
          dispositions: [],
          arrivingAssets: arriving,
          sponsoredEntries: [],
          resolutions: demo_sponsored
            ? [
                {
                  blocker: "sponsorship_claimable_balance_unrevocable",
                  kind: "claim_sponsored_balance",
                },
              ]
            : [],
        },
        cost: cost(
          steps.length,
          2,
          issuers.length * ISSUER_FUNDING + trusted.length * BASE_RESERVE_XLM + sponsoredXlm,
          trusted.length
        ),
      },
    };
  },
};

const VARIANTS: readonly SponsorshipVariant[] = ["sponsor_pays", "demo_sponsors", "unrevocable"];

const sponsoredReserves: ScenarioDefinition = {
  id: "sponsored-reserves",
  featureSet: "classic",
  label: "Sponsored reserves",
  description:
    "Reserves paid by another account: the demo's own entries paid by a sponsor, or another account's entries paid by the demo, which the close revokes or reports when it cannot.",
  params: {
    variant: {
      label: "Who pays",
      min: 0,
      max: VARIANTS.length - 1,
      default: 0,
      choices: [
        "A sponsor pays for the demo's entries",
        "The demo pays for another account's entries",
        "The demo pays, and the other account cannot take over",
      ],
    },
  },
  heldAssets: ({ variant }) => (VARIANTS[variant ?? 0] === "sponsor_pays" ? ["PERK"] : []),
  requiresAnyOf: [],
  conflicts: [],
  build: ({ variant: index }) => {
    const variant = VARIANTS[index ?? 0];
    if (!variant) return { ok: false, message: "Sponsored reserves has no such variant." };
    const sponsorPays = variant === "sponsor_pays";
    const dataEntry = sponsorPays ? SPONSORED_DATA_ENTRY : BENEFICIARY_DATA_ENTRY;
    const helperFundingXlm = sponsorPays
      ? SPONSOR_FUNDING_XLM
      : variant === "demo_sponsors"
        ? BENEFICIARY_FUNDING_XLM
        : UNREVOCABLE_BENEFICIARY_FUNDING_XLM;
    const step: MessStepDef = {
      id: "SPONSORED_ENTRIES",
      label: sponsorPays
        ? "Open a trustline, a data entry and an offer whose reserves a sponsor pays"
        : "Pay the reserves of another account's trustline and data entry",
      nodes: sponsorPays
        ? [
            { id: trustlineNode("PERK"), kind: "trustline", label: "PERK" },
            { id: `data:${dataEntry.key}`, kind: "data", label: dataEntry.key },
            {
              id: "offer:sponsored",
              kind: "offer",
              label: `Sell XLM → PERK`,
              offer: { selling: SPONSORED_OFFER.selling, buying: SPONSORED_OFFER.buying },
            },
          ]
        : [],
      balances: [],
      action: { kind: "sponsored_entries", variant, asset: "PERK", dataEntry, helperFundingXlm },
    };
    // The demo's own reserves when it sponsors: one per entry it pays for.
    const demoReserves = sponsorPays ? 0 : 2 * BASE_RESERVE_XLM;
    return {
      ok: true,
      build: {
        steps: [{ order: ORDER.sponsorships, step }],
        ephemeralAssets: ["PERK"],
        expectation: sponsorPays
          ? {
              assets: ["PERK"],
              offers: 1,
              dataEntries: 1,
              signers: 0,
              closeOperations: 4,
              operationTypes: ["changeTrust", "manageData", "manageSellOffer"],
              dispositions: [],
              arrivingAssets: [],
              sponsoredEntries: [],
              resolutions: [],
            }
          : {
              assets: [],
              offers: 0,
              dataEntries: 0,
              signers: 0,
              closeOperations: 2,
              operationTypes: ["revokeTrustlineSponsorship", "revokeDataSponsorship"],
              dispositions: [],
              arrivingAssets: [],
              sponsoredEntries: [
                { kind: "trustline", asset: "PERK" },
                { kind: "data_entry", name: dataEntry.key },
              ],
              resolutions:
                variant === "unrevocable"
                  ? [{ blocker: "sponsorship_unaffordable", kind: "release_sponsored_entries" }]
                  : [],
            },
        cost: cost(
          1,
          1,
          ISSUER_FUNDING + Number(helperFundingXlm) + demoReserves,
          sponsorPays ? 3 : 0
        ),
      },
    };
  },
};

const MULTISIG_VARIANTS: readonly MultisigVariant[] = ["two_of_three", "hash_x", "pre_auth"];

const COSIGNER_NODES: SceneNodeSpec[] = [
  { id: "signer:cosigner:1", kind: "signer", label: "Co-signer 1" },
  { id: "signer:cosigner:2", kind: "signer", label: "Co-signer 2" },
];

const MULTISIG_NODES: Record<MultisigVariant, SceneNodeSpec[]> = {
  two_of_three: COSIGNER_NODES,
  hash_x: [{ id: "signer:hashx", kind: "signer", label: "hash(x) signer" }],
  pre_auth: [
    ...COSIGNER_NODES,
    { id: "signer:preauth", kind: "signer", label: "Dormant pre-authorized transaction" },
  ],
};

/**
 * What a multi-signature demo costs beyond its signers' reserves: the mess transaction that adds
 * them and the close's own transaction that removes them, each at the most it can be charged.
 */
export function multisigFeesXlm(signers: number): number {
  const ops = signers + 1;
  return 2 * ops * ops * BASE_FEE_XLM + ops * BASE_FEE_XLM;
}

const multisig: ScenarioDefinition = {
  id: "multisig",
  featureSet: "classic",
  label: "Multi-signature account",
  description:
    "Thresholds of two, so the master key alone cannot close the account: the close first removes the other signers, signed with the keys, hash(x) preimage or nothing at all for a dormant pre-authorized transaction.",
  params: {
    variant: {
      label: "Signers",
      min: 0,
      max: MULTISIG_VARIANTS.length - 1,
      default: 0,
      choices: [
        "Two of three keys",
        "Master key and a hash(x) signer",
        "Two of three keys and a dormant pre-authorized transaction",
      ],
    },
  },
  heldAssets: () => [],
  requiresAnyOf: [],
  conflicts: [],
  build: ({ variant: index }) => {
    const variant = MULTISIG_VARIANTS[index ?? 0];
    if (!variant) return { ok: false, message: "Multi-signature account has no such variant." };
    const nodes = MULTISIG_NODES[variant];
    const signers = nodes.length;
    return {
      ok: true,
      build: {
        steps: [
          {
            order: ORDER.multisig,
            step: {
              id: "MULTISIG",
              label: `Add ${signers} ${plural(signers, "signer", "signers")} with weight ${MULTISIG_SIGNER_WEIGHT} and raise the thresholds to ${MULTISIG_THRESHOLD}`,
              nodes,
              balances: [],
              action: { kind: "multisig", variant },
            },
          },
        ],
        ephemeralAssets: [],
        expectation: {
          assets: [],
          offers: 0,
          dataEntries: 0,
          signers,
          closeOperations: signers,
          operationTypes: ["setOptions"],
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
        },
        cost: cost(1, 2, signers * BASE_RESERVE_XLM + multisigFeesXlm(signers), signers),
      },
    };
  },
};

/** The most a Soroban call may pay, in XLM (lib/soroban-submit.ts `MAX_SOROBAN_FEE_STROOPS`). */
const SOROBAN_FEE_CAP_XLM = 1;
/** A Soroban step simulates, sends and waits for its ledger: slower than a classic one. */
const SOROBAN_STEP_SECONDS = 10;

/**
 * A scenario that pairs Circle's USDC with XLM in a pinned pool: one seeding call, which spends the
 * USDC the plan buys for it (lib/scenarios/prerequisites.ts adds the trustline and the purchase,
 * once for every pool selected), and one exit, a close transaction of its own.
 */
function poolScenario(spec: {
  id: ScenarioId;
  label: string;
  description: string;
  stepId: MessStepId;
  stepLabel: string;
  node: { id: string; label: string };
  action: StepAction;
  seed: { usdc: string; buyMaxXlm: string; depositMaxXlm: string };
}): ScenarioDefinition {
  return {
    id: spec.id,
    featureSet: "protocol",
    label: spec.label,
    description: spec.description,
    params: {},
    heldAssets: () => [],
    requiresAnyOf: [],
    conflicts: [],
    build: () => ({
      ok: true,
      build: {
        steps: [
          {
            order: ORDER.protocol,
            step: {
              id: spec.stepId,
              label: spec.stepLabel,
              nodes: [{ id: spec.node.id, kind: "position", label: spec.node.label }],
              balances: [],
              action: spec.action,
              spendsPinned: {
                asset: "circle-usdc",
                amount: spec.seed.usdc,
                maxXlm: spec.seed.buyMaxXlm,
              },
            },
          },
        ],
        ephemeralAssets: [],
        expectation: {
          assets: [],
          offers: 0,
          dataEntries: 0,
          signers: 0,
          // The exit is a transaction of its own; the USDC it pays back is closed with the
          // trustline the shared purchase opened.
          closeOperations: 0,
          operationTypes: ["invokeHostFunction"],
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
        },
        cost: {
          // The XLM the deposit locks until the exit pays it back, and the fee ceiling of the
          // deposit and of the exit. The trustline's reserve and the purchase are the shared
          // purchase's.
          xlm: Number(spec.seed.depositMaxXlm) + 2 * SOROBAN_FEE_CAP_XLM,
          classicTransactions: 0,
          sorobanTransactions: 1,
          seconds: SOROBAN_STEP_SECONDS + CLOSE_GROUP_SECONDS + SOROBAN_STEP_SECONDS,
          batchSize: 1,
          subEntries: 0,
        },
      },
    }),
  };
}

const soroswapLp = poolScenario({
  id: "soroswap-lp",
  label: "Soroswap liquidity",
  description:
    "Circle's test USDC bought on the DEX and paired with XLM in a real Soroswap pool. The close withdraws it before the merge.",
  stepId: "SOROSWAP_DEPOSIT",
  stepLabel: "Add USDC and XLM to the Soroswap pool",
  node: { id: "lp:soroswap", label: "Soroswap USDC/XLM" },
  action: {
    kind: "soroswap_deposit",
    usdc: SOROSWAP_SEED.usdc,
    maxXlm: SOROSWAP_SEED.depositMaxXlm,
  },
  seed: SOROSWAP_SEED,
});

const aquariusLp = poolScenario({
  id: "aquarius-lp",
  label: "Aquarius liquidity",
  description:
    "Circle's test USDC bought on the DEX and paired with XLM in a real Aquarius pool. The close withdraws it before the merge.",
  stepId: "AQUARIUS_DEPOSIT",
  stepLabel: "Add USDC and XLM to the Aquarius pool",
  node: { id: "lp:aquarius", label: "Aquarius USDC/XLM" },
  action: {
    kind: "aquarius_deposit",
    usdc: AQUARIUS_SEED.usdc,
    maxXlm: AQUARIUS_SEED.depositMaxXlm,
  },
  seed: AQUARIUS_SEED,
});

const BLEND_VARIANTS: readonly BlendVariant[] = ["supply", "supply_and_borrow"];

/**
 * XLM supplied to the pinned Blend pool as collateral in one `submit`, and in the borrow variant
 * XLM borrowed against it in the same call. The close leaves the pool through the API's Blend
 * exit, one `submit` per step: the repay first when there is a debt, then the collateral's
 * withdrawal, each a transaction of its own. The pool lends XLM only below its utilization cap,
 * which the borrow variant's executor reads before anything is signed.
 */
const blendSupply: ScenarioDefinition = {
  id: "blend-supply",
  featureSet: "protocol",
  label: "Blend lending",
  description:
    "XLM supplied as collateral to a real Blend pool, optionally with XLM borrowed against it. The close repays any debt, then withdraws the collateral, before the merge.",
  params: {
    variant: {
      label: "Position",
      min: 0,
      max: BLEND_VARIANTS.length - 1,
      default: 0,
      choices: ["Supply XLM as collateral", "Supply XLM and borrow XLM against it"],
    },
  },
  heldAssets: () => [],
  requiresAnyOf: [],
  conflicts: [],
  build: ({ variant: index }) => {
    const variant = BLEND_VARIANTS[index ?? 0];
    if (!variant) return { ok: false, message: "Blend lending has no such variant." };
    const borrows = variant === "supply_and_borrow";
    // The seeding call, then one exit transaction per step: a repay when there is a debt, and the
    // collateral's withdrawal.
    const exits = borrows ? 2 : 1;
    return {
      ok: true,
      build: {
        steps: [
          {
            order: ORDER.protocol,
            step: {
              id: "BLEND_SUBMIT",
              label: borrows
                ? `Supply ${BLEND_SEED.supplyXlm} XLM to Blend and borrow ${BLEND_SEED.borrowXlm} XLM against it`
                : `Supply ${BLEND_SEED.supplyXlm} XLM to Blend as collateral`,
              nodes: [
                {
                  id: "lend:blend",
                  kind: "position",
                  label: borrows ? "Blend XLM collateral and debt" : "Blend XLM collateral",
                },
              ],
              balances: [],
              action: {
                kind: "blend_submit",
                variant,
                supplyXlm: BLEND_SEED.supplyXlm,
                borrowXlm: borrows ? BLEND_SEED.borrowXlm : null,
              },
            },
          },
        ],
        ephemeralAssets: [],
        expectation: {
          assets: [],
          offers: 0,
          dataEntries: 0,
          signers: 0,
          // Each exit is a transaction of its own, and a position holds no entry on the account.
          closeOperations: 0,
          operationTypes: ["invokeHostFunction"],
          dispositions: [],
          arrivingAssets: [],
          sponsoredEntries: [],
          resolutions: [],
        },
        cost: {
          // The XLM the collateral locks until the exit withdraws it, and the fee ceiling of the
          // seeding call and of each exit. A borrow is paid out to the demo and repaid from it.
          xlm: Number(BLEND_SEED.supplyXlm) + (1 + exits) * SOROBAN_FEE_CAP_XLM,
          classicTransactions: 0,
          sorobanTransactions: 1,
          seconds: SOROBAN_STEP_SECONDS + CLOSE_GROUP_SECONDS + exits * SOROBAN_STEP_SECONDS,
          batchSize: 1,
          subEntries: 0,
        },
      },
    };
  },
};

/** Every scenario, in the order a selection lists them. */
export const SCENARIOS: readonly ScenarioDefinition[] = [
  lwdemoHolding,
  junkAirdrops,
  stablecoinSwaps,
  dataEntries,
  staleOffers,
  forgottenSigner,
  dispositions,
  claimableBalances,
  sponsoredReserves,
  multisig,
  soroswapLp,
  aquariusLp,
  blendSupply,
];
