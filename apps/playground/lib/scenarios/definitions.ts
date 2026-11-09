import {
  AIRDROP_ASSETS,
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
  TIME_GATED_AMOUNT,
  UNREVOCABLE_BENEFICIARY_FUNDING_XLM,
  SWAP_ASSETS,
  type AssetCode,
  type OfferAsset,
} from "./catalog";
import {
  DISPOSITION_CHOICES,
  type AssetDisposition,
  type ClaimableBalanceSpec,
  type SponsorshipVariant,
  type CloseOperationType,
  type DispositionChoice,
  type MessStepDef,
  type MessStepId,
  type OrderedStep,
  type ScenarioCost,
  type ScenarioDefinition,
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
  signers: 90,
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
];
