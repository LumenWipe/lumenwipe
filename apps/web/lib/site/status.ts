import {
  CONTRACT_REGISTRY_DATES,
  exitCapableProtocols,
  EXIT_FUNCTIONS,
  isContractRegistryUsable,
} from "@/lib/contract-registry";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { PROTOCOL_LABELS } from "@/lib/plan/describe-position";
import type { DefiPosition } from "@/types/account";

/** Live means available on mainnet; testnet-only means it runs on testnet and not yet on mainnet. */
export type SiteStatus = "live" | "testnet-only" | "soon";

const COPY = SITE[SITE_LOCALE];

export const STATUS_LABEL: Record<SiteStatus, string> = COPY.statusLabel;

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

/** The protocol statuses are read from the bundled contract registry, so they are as current as
 *  its last check, and are not relied on past its `validUntil`. */
export const PROTOCOLS_VERIFIED = CONTRACT_REGISTRY_DATES;

/** Whether the protocol statuses may still be relied on at `now`. */
export function protocolStatusUsable(now: Date): boolean {
  return isContractRegistryUsable(now);
}

export function protocolsWithStatus(status: SiteStatus): readonly SiteProtocol[] {
  return PROTOCOLS.filter((p) => p.status === status);
}

export const LIVE_EXIT_PROTOCOLS = protocolsWithStatus("live");

/** "A, B and C". */
export function listNames(items: readonly { name: string }[]): string {
  return COPY.list(items.map((i) => i.name));
}

type FeatureState = Pick<SiteFeature, "id" | "status"> & { href?: string };

// Exchange closes and sponsored fees follow the mainnet rows of the service-account inventory in
// docs/monitoring-plan.md; tests/unit/site-status-docs.test.ts fails when the two disagree.
const FEATURE_STATES: readonly FeatureState[] = [
  { id: "classic-close", status: "live" },
  {
    id: "defi-exits",
    status:
      LIVE_EXIT_PROTOCOLS.length > 0
        ? "live"
        : protocolsWithStatus("testnet-only").length > 0
          ? "testnet-only"
          : "soon",
  },
  { id: "exchange-close", status: "testnet-only" },
  { id: "sponsored-fees", status: "testnet-only" },
  { id: "allowance-inspector", status: "live", href: "/mainnet/allowances" },
  { id: "resumable-sessions", status: "live" },
  { id: "deterministic-plan", status: "live" },
];

export const FEATURES: readonly SiteFeature[] = FEATURE_STATES.map(({ id, status, href }) => {
  const { title, noun, summary, linkLabel } = COPY.features[id];
  if (href && !linkLabel) throw new Error(`Feature ${id} links to ${href} with no label`);
  return {
    id,
    title,
    noun,
    summary,
    status,
    ...(href && linkLabel ? { link: { href, label: linkLabel } } : {}),
  };
});

export function feature(id: FeatureId): SiteFeature {
  const found = FEATURES.find((f) => f.id === id);
  if (!found) throw new Error(`Unknown feature ${id}`);
  return found;
}

/** What runs on testnet but not yet on mainnet, as one sentence; "" when nothing does. */
export function testnetOnlySentence(): string {
  const names = [
    ...FEATURES.filter((f) => f.status === "testnet-only").map((f) => f.noun),
    ...protocolsWithStatus("testnet-only").map((p) => COPY.protocolExits(p.name)),
  ];
  return names.length === 0 ? "" : COPY.testnetOnly(names);
}
