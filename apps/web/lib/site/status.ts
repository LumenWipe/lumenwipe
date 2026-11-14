import { exitCapableProtocols, EXIT_FUNCTIONS } from "@/lib/contract-registry";
import { PROTOCOL_LABELS } from "@/lib/plan/describe-position";
import type { DefiPosition } from "@/types/account";

/** Live means available on mainnet; testnet-only means it runs on testnet and not yet on mainnet. */
export type SiteStatus = "live" | "testnet-only" | "soon";

export const STATUS_LABEL: Record<SiteStatus, string> = {
  live: "Live",
  "testnet-only": "Testnet only",
  soon: "Soon",
};

export type ExitProtocol = DefiPosition["protocol"];

export interface SiteProtocol {
  id: ExitProtocol;
  name: string;
  status: SiteStatus;
}

export type FeatureId =
  | "classic-close"
  | "defi-exits"
  | "exchange-close"
  | "sponsored-fees"
  | "allowance-inspector"
  | "resumable-sessions"
  | "deterministic-plan";

export interface SiteFeature {
  id: FeatureId;
  title: string;
  /** How a sentence names it, lower case. */
  noun: string;
  summary: string;
  status: SiteStatus;
  link?: { href: string; label: string };
}

function protocolStatus(id: ExitProtocol): SiteStatus {
  if (exitCapableProtocols("mainnet").has(id)) return "live";
  if (exitCapableProtocols("testnet").has(id)) return "testnet-only";
  return "soon";
}

export const PROTOCOLS: readonly SiteProtocol[] = (
  Object.keys(EXIT_FUNCTIONS) as ExitProtocol[]
).map((id) => ({ id, name: PROTOCOL_LABELS[id], status: protocolStatus(id) }));

export function protocolsWithStatus(status: SiteStatus): readonly SiteProtocol[] {
  return PROTOCOLS.filter((p) => p.status === status);
}

export const LIVE_EXIT_PROTOCOLS = protocolsWithStatus("live");

/** "A, B and C". */
export function listNames(items: readonly { name: string }[]): string {
  const names = items.map((i) => i.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// Exchange closes and sponsored fees follow the mainnet rows of the service-account inventory in
// docs/monitoring-plan.md; tests/unit/site-status-docs.test.ts fails when the two disagree.
export const FEATURES: readonly SiteFeature[] = [
  {
    id: "classic-close",
    title: "Classic account close",
    noun: "classic closes",
    summary:
      "Removes signers, data entries, offers and trustlines, converts or returns leftover assets, and merges the account into a wallet you choose.",
    status: "live",
  },
  {
    id: "defi-exits",
    title: "Soroban DeFi exits",
    noun: "Soroban DeFi exits",
    summary:
      "Detects positions through OctoPos and exits each one with its own protocol adapter, repaying loans, withdrawing liquidity and unstaking, before the trustline is removed.",
    status:
      LIVE_EXIT_PROTOCOLS.length > 0
        ? "live"
        : protocolsWithStatus("testnet-only").length > 0
          ? "testnet-only"
          : "soon",
  },
  {
    id: "exchange-close",
    title: "Exchange-compatible close",
    noun: "exchange closes",
    summary:
      "A shared relay account receives the merge and pays the balance on to an exchange deposit address, with the memo the exchange requires, in the same transaction.",
    status: "testnet-only",
  },
  {
    id: "sponsored-fees",
    title: "Sponsored fees",
    noun: "sponsored fees",
    summary:
      "Pays the network fee for an account sitting at its minimum balance, through a fee-bump envelope around the transaction you signed.",
    status: "testnet-only",
  },
  {
    id: "allowance-inspector",
    title: "Allowance inspector",
    noun: "the allowance inspector",
    summary:
      "See every token approval your account granted to DeFi contracts, and revoke risky ones, even without closing.",
    status: "live",
    link: { href: "/mainnet/allowances", label: "Open the allowance inspector" },
  },
  {
    id: "resumable-sessions",
    title: "Resumable sessions",
    noun: "resumable sessions",
    summary:
      "Close the tab mid-flow and resume in the same browser: the account is re-read and a fresh plan covers only what is left, so confirmed work is not repeated.",
    status: "live",
  },
  {
    id: "deterministic-plan",
    title: "Deterministic, auditable plan",
    noun: "deterministic plans",
    summary:
      "The same account state always produces the same ordered plan: testable, reviewable, never built on stale data.",
    status: "live",
  },
];

export function feature(id: FeatureId): SiteFeature {
  const found = FEATURES.find((f) => f.id === id);
  if (!found) throw new Error(`Unknown feature ${id}`);
  return found;
}

/** What runs on testnet but not yet on mainnet, as one sentence; "" when nothing does. */
export function testnetOnlySentence(): string {
  const items = [
    ...FEATURES.filter((f) => f.status === "testnet-only").map((f) => ({ name: f.noun })),
    ...protocolsWithStatus("testnet-only").map((p) => ({ name: `${p.name} exits` })),
  ];
  if (items.length === 0) return "";
  const list = listNames(items);
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} run on testnet only today.`;
}
