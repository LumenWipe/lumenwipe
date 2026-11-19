import type { Locale } from "@/lib/i18n/locale";
import type { FeatureId, SiteStatus } from "@/lib/site/status";

export interface FeatureCopy {
  title: string;
  /** How a sentence names it, lower case. */
  noun: string;
  summary: string;
  linkLabel?: string;
}

export interface ServerKeyCopy {
  name: string;
  statement: string;
}

const STATUS_LABEL: Record<SiteStatus, string> = {
  live: "Live",
  "testnet-only": "Testnet only",
  soon: "Soon",
};

const FEATURES: Record<FeatureId, FeatureCopy> = {
  "classic-close": {
    title: "Classic account close",
    noun: "classic closes",
    summary:
      "Removes signers, data entries, offers and trustlines, converts or returns leftover assets, and merges the account into a wallet you choose.",
  },
  "defi-exits": {
    title: "Soroban DeFi exits",
    noun: "Soroban DeFi exits",
    summary:
      "Detects positions through OctoPos and exits each one with its own protocol adapter, repaying loans, withdrawing liquidity and unstaking, before the trustline is removed.",
  },
  "exchange-close": {
    title: "Exchange-compatible close",
    noun: "exchange closes",
    summary:
      "A shared relay account receives the merge and pays the balance on to an exchange deposit address, with the memo the exchange requires, in the same transaction.",
  },
  "sponsored-fees": {
    title: "Sponsored fees",
    noun: "sponsored fees",
    summary:
      "Pays the network fee for an account sitting at its minimum balance, through a fee-bump envelope around the transaction you signed.",
  },
  "allowance-inspector": {
    title: "Allowance inspector",
    noun: "the allowance inspector",
    summary:
      "See every token approval your account granted to DeFi contracts, and revoke risky ones, even without closing.",
    linkLabel: "Open the allowance inspector",
  },
  "resumable-sessions": {
    title: "Resumable sessions",
    noun: "resumable sessions",
    summary:
      "Close the tab mid-flow and resume in the same browser: the account is re-read and a fresh plan covers only what is left, so confirmed work is not repeated.",
  },
  "deterministic-plan": {
    title: "Deterministic, auditable plan",
    noun: "deterministic plans",
    summary:
      "The same account state always produces the same ordered plan: testable, reviewable, never built on stale data.",
  },
};

const SERVER_KEYS: Record<"exchange-close" | "sponsored-fees", ServerKeyCopy> = {
  "exchange-close": {
    name: "Relay account key",
    statement:
      "In an exchange close, it co-signs only a two-operation transaction: your account's merge into the relay account and an XLM payment from it in the same transaction. Before you sign, your browser checks that this payment goes to the exchange address you typed.",
  },
  "sponsored-fees": {
    name: "Fee-sponsor key",
    statement:
      "When a fee is sponsored, it signs only the fee-bump envelope that pays the network fee for a transaction you already signed, and cannot change that transaction.",
  },
};

/** "A, B and C". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const en = {
  statusLabel: STATUS_LABEL,
  list,
  features: FEATURES,
  protocolExits: (protocol: string): string => `${protocol} exits`,
  /** What runs on testnet but not yet on mainnet, from the registry's names for it. */
  testnetOnly(names: readonly string[]): string {
    const listed = list(names);
    return `${listed.charAt(0).toUpperCase()}${listed.slice(1)} run on testnet only today.`;
  },
  trust: {
    key: "Your secret key never reaches a LumenWipe server, and LumenWipe does not store or log it: you sign in your browser, through your wallet or a key held in memory for this session only.",
    check:
      "The LumenWipe API reads your account and builds each unsigned transaction. Before you sign, your browser decodes it and checks its operations and destination against what you entered; if they do not match, it stops before asking you to sign.",
    serverKeysIntro: "Two keys sign on the server, and neither can sign for your account.",
    serverKeys: SERVER_KEYS,
    scope: (statusLabel: string): string => `${statusLabel} today.`,
  },
  numbers: {
    reserveSource: "Stellar docs",
    reserveValue: (minimum: number, perItem: number): string =>
      `${minimum} XLM plus ${perItem} per item`,
    reserveLabel:
      "locked in reserve per account, where an item is a trustline, offer, data entry or signer",
    liveExitsLabel: "DeFi protocols with a mainnet exit",
    lastVerifiedLabel: "protocol contracts last checked against their live code",
    example: {
      minimum: "Account minimum",
      trustlines: (n: number): string => `${n} trustlines`,
      offers: (n: number): string => `${n} open offers`,
      dataAndSigner: (entries: number, signers: number): string =>
        `${entries} data entry · ${signers} signer`,
    },
    heroOutcome({
      minimum,
      perItem,
      defiLive,
    }: {
      minimum: number;
      perItem: number;
      defiLive: boolean;
    }): string {
      const exits = defiLive ? "exits your DeFi positions, " : "";
      return (
        `Get back the ${minimum} XLM every account must hold, plus ${perItem} XLM for each ` +
        `trustline, offer, data entry and signer. LumenWipe clears them, ${exits}converts leftover ` +
        "tokens to XLM and merges the balance into your wallet. You sign every transaction in your " +
        "browser."
      );
    },
  },
  metadata: {
    defaultTitle: "LumenWipe - Close a Stellar Account",
    homeTitle: "LumenWipe: Recover the XLM locked in your Stellar account",
    description:
      "Close your Stellar account safely. Recover locked XLM reserves, remove trustlines, cancel open offers, and exit Soroban DeFi positions in one non-custodial workflow.",
    keywords: [
      "Stellar",
      "XLM",
      "Lumens",
      "account merge",
      "non-custodial",
      "Soroban",
      "DeFi",
      "trustline",
      "blockchain",
      "LumenWipe",
    ],
    shareImageAlt: "LumenWipe: an example close plan and the XLM it recovers",
    blogDescription:
      "Technical deep dives, project updates, and guides on Stellar account management, trustline removal, reserve recovery, and non-custodial DeFi tooling.",
    blogName: (siteName: string): string => `${siteName} blog`,
  },
  structuredData: {
    home: "Home",
    blog: "Blog",
    /** The feature-list entry naming the protocols with a live exit, from the registry's names. */
    positionExits: (protocols: string): string => `Position exits: ${protocols}`,
  },
};

export type SiteCopy = typeof en;

export const SITE: Record<Locale, SiteCopy> = { en, es: en };
