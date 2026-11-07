"use client";

import { useId, type ComponentProps } from "react";
import { ChevronDown } from "lucide-react";
import type { AccountState, UnrecognizedDefiPosition } from "@/types/account";
import { PROTOCOL_LABELS, describeDefiPosition } from "@/lib/plan/describe-position";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { formatAsset } from "@/lib/utils/assets";
import AssetDispositionCard from "./AssetDispositionCard";
import TokenDispositionCard from "./TokenDispositionCard";
import ClaimBalancesSection from "./ClaimBalancesSection";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { chipLabel, type GroupChip, type PlanGroupType } from "@/lib/plan/open-items";
import { FullAddress } from "@/components/ui/full-address";
import { ShortAddress } from "@/components/ui/short-address";

interface PlanAccordionProps {
  /** The group shown open, owned by the page so a jump can open the one it moves to. */
  open: PlanGroupType | null;
  onOpenChange: (open: PlanGroupType | null) => void;
  /** Each decision group's chip; a group without one is informational. */
  chips: Partial<Record<PlanGroupType, GroupChip>>;
  account: AccountState;
  conversions: AssetConvertibility[];
  /** Each balance-bearing asset's recorded disposition, keyed by asset. Absent means the
   *  user has not answered yet. */
  assetDispositions: Record<string, AssetDisposition>;
  transferDestinations: Record<string, string>;
  /** The account the XLM is merging into, offered per asset as a shortcut. */
  mergeDestination: string | null;
  onSetDisposition: (asset: string, disposition: AssetDisposition) => void;
  onSetTransferDestination: (asset: string, destination: string | null) => void;
  /** Whether a flagged token conversion is confirmed at the floor it carries now. */
  isImpactConfirmed: (asset: string) => boolean;
  onConfirmImpact: (asset: string, confirmed: boolean) => void;
  claimableBalanceDecisions: ClaimableBalanceDecision[];
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>;
  onSelectClaimableBalance: (balanceId: string, selection: ClaimableBalanceSelection) => void;
  onBulkSelectClaimableBalances: ComponentProps<typeof ClaimBalancesSection>["onBulkSelect"];
  onUndoClaimableBalances: ComponentProps<typeof ClaimBalancesSection>["onUndo"];
  /** Set once the destination is entered; the merge group shows it. */
  destinationAddress: string | null;
  mediatorRequired: boolean;
}

type GroupType = PlanGroupType;

interface Group {
  type: GroupType;
  title: string;
  summary: string;
  body: React.ReactNode;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

const CHIP_TONE = { needs: "warning", done: "success", informational: "neutral" } as const;

export default function PlanAccordion({
  open,
  onOpenChange,
  chips,
  account,
  conversions,
  assetDispositions,
  transferDestinations,
  mergeDestination,
  onSetDisposition,
  onSetTransferDestination,
  isImpactConfirmed,
  onConfirmImpact,
  claimableBalanceDecisions,
  claimableBalanceSelections,
  onSelectClaimableBalance,
  onBulkSelectClaimableBalances,
  onUndoClaimableBalances,
  destinationAddress,
  mediatorRequired,
}: PlanAccordionProps) {
  const baseId = useId();

  const groups: Group[] = [];

  const extraSigners = account.signers.filter((s) => s.key !== account.address);
  const needsSignerNormalization =
    extraSigners.length > 0 || account.thresholds.med > 1 || account.thresholds.high > 1;
  if (needsSignerNormalization) {
    groups.push({
      type: "NORMALIZE_SIGNERS",
      title: "Remove signers",
      summary: `${extraSigners.length} extra signer${extraSigners.length === 1 ? "" : "s"}, reset thresholds`,
      body: (
        <ul className="space-y-1">
          {extraSigners.map((s) => (
            <li key={s.key} className="font-mono-address text-xs text-fg-muted">
              {shortAddr(s.key)} <span className="text-fg-subtle">· weight {s.weight}</span>
            </li>
          ))}
          {extraSigners.length === 0 && (
            <li className="text-xs text-fg-muted">Reset authorization thresholds to single-key.</li>
          )}
        </ul>
      ),
    });
  }

  const revocableSponsorships = account.sponsoredEntries.filter(
    (e) => e.kind !== "claimable_balance"
  );
  if (revocableSponsorships.length > 0) {
    groups.push({
      type: "REVOKE_SPONSORSHIP",
      title: "Revoke sponsorships",
      summary: `${revocableSponsorships.length} sponsored entr${revocableSponsorships.length === 1 ? "y" : "ies"} on other accounts`,
      body: (
        <ul className="space-y-1">
          {revocableSponsorships.map((entry, i) => (
            <li key={i} className="text-xs text-fg-muted">
              {entry.kind === "trustline" && `Trustline for ${entry.asset.split(":")[0]}`}
              {entry.kind === "offer" && `Offer ${entry.offerId}`}
              {entry.kind === "data_entry" && `Data entry "${entry.name}"`}
              {entry.kind === "signer" && "Signer"}
              {entry.kind === "account" && "Account creation"}{" "}
              <span className="font-mono-address text-fg-subtle">on {shortAddr(entry.owner)}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (account.dataEntries.length > 0) {
    groups.push({
      type: "REMOVE_DATA_ENTRIES",
      title: "Remove data",
      summary: `${account.dataEntries.length} data entr${account.dataEntries.length === 1 ? "y" : "ies"}`,
      body: (
        <ul className="space-y-1">
          {account.dataEntries.map((d) => (
            <li key={d.key} className="font-mono text-xs text-fg-muted truncate">
              {d.key}
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (account.openOffers.length > 0) {
    groups.push({
      type: "CANCEL_OFFERS",
      title: "Cancel offers",
      summary: `${account.openOffers.length} open offer${account.openOffers.length === 1 ? "" : "s"}`,
      body: (
        <ul className="space-y-1">
          {account.openOffers.map((o) => (
            <li key={o.id} className="text-xs text-fg-muted">
              <span className="text-white/70">{o.amount}</span> {formatAsset(o.selling)}{" "}
              <span className="text-fg-subtle">→</span> {formatAsset(o.buying)}{" "}
              <span className="text-fg-subtle">@ {o.price}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (claimableBalanceDecisions.length > 0) {
    groups.push({
      type: "CLAIM_BALANCES",
      title: "Claim balances",
      summary: `${claimableBalanceDecisions.length} claimable balance${claimableBalanceDecisions.length === 1 ? "" : "s"}`,
      body: (
        <ClaimBalancesSection
          decisions={claimableBalanceDecisions}
          selections={claimableBalanceSelections}
          onSelect={onSelectClaimableBalance}
          onBulkSelect={onBulkSelectClaimableBalances}
          onUndo={onUndoClaimableBalances}
        />
      ),
    });
  }

  const { positions, unrecognizedPositions } = account.defiPositions;
  // Every "defi_position_unrecognized" warning maps 1:1 to an entry already listed in
  // unrecognizedPositions below (both derive from the same assessDefiPositionsGate call) - drop
  // it here rather than repeat the same fact twice with two different phrasings. Staleness and
  // unavailability warnings have no such counterpart and still need to render.
  const defiWarnings = account.defiPositionsWarnings.filter(
    (w) => w.code !== "defi_position_unrecognized"
  );
  if (positions.length > 0 || unrecognizedPositions.length > 0 || defiWarnings.length > 0) {
    const summary =
      positions.length > 0
        ? `${positions.length} position${positions.length === 1 ? "" : "s"} detected`
        : "Could not be confirmed - verify manually";
    groups.push({
      type: "DEFI_POSITIONS",
      title: "DeFi positions",
      summary,
      body: (
        <div className="space-y-2">
          {positions.length > 0 && (
            <ul className="space-y-1">
              {positions.map((p, i) => (
                <li key={i} className="text-xs text-fg-muted">
                  {describeDefiPosition(p, account.defiPositions.enrichment)}
                  {p.usdValue && <span className="text-fg-subtle"> · ≈ ${p.usdValue}</span>}
                </li>
              ))}
            </ul>
          )}
          {unrecognizedPositions.length > 0 && (
            <ul className="space-y-1">
              {unrecognizedPositions.map((u: UnrecognizedDefiPosition, i) => (
                <li key={i} className="text-xs text-warning">
                  {PROTOCOL_LABELS[u.protocol]} position could not be read ({u.reason}) - verify
                  manually.
                </li>
              ))}
            </ul>
          )}
          {defiWarnings.length > 0 && (
            <ul className="space-y-1">
              {defiWarnings.map((w, i) => (
                <li key={i} className="text-xs text-warning">
                  {w.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    });
  }

  if (conversions.length > 0) {
    groups.push({
      type: "HANDLE_ASSETS",
      title: "Handle assets",
      summary: `${conversions.length} asset${conversions.length === 1 ? "" : "s"} with a balance`,
      body: (
        <div className="space-y-2">
          {conversions.map((c) => (
            <div key={c.asset} data-open-item={`asset:${c.asset}`}>
              {c.token ? (
                <TokenDispositionCard
                  item={c}
                  disposition={assetDispositions[c.asset]}
                  transferDestination={transferDestinations[c.asset]}
                  mergeDestination={mediatorRequired ? null : mergeDestination}
                  onSetDisposition={onSetDisposition}
                  onSetTransferDestination={onSetTransferDestination}
                  impactConfirmed={isImpactConfirmed(c.asset)}
                  onConfirmImpact={onConfirmImpact}
                />
              ) : (
                <AssetDispositionCard
                  item={c}
                  disposition={assetDispositions[c.asset]}
                  transferDestination={transferDestinations[c.asset]}
                  mergeDestination={mergeDestination}
                  onSetDisposition={onSetDisposition}
                  onSetTransferDestination={onSetTransferDestination}
                />
              )}
            </div>
          ))}
        </div>
      ),
    });
  }

  if (account.trustlines.length > 0) {
    groups.push({
      type: "REMOVE_TRUSTLINES",
      title: "Remove trustlines",
      summary: `${account.trustlines.length} trustline${account.trustlines.length === 1 ? "" : "s"}`,
      body: (
        <ul className="space-y-1">
          {account.trustlines.map((tl) => (
            <li key={tl.asset} className="text-xs text-fg-muted">
              {tl.code} <span className="text-fg-subtle">· balance {tl.balance}</span>
              {tl.issuer && (
                <span className="text-fg-subtle">
                  {" "}
                  · issued by <ShortAddress value={tl.issuer} label={`${tl.code} issuer address`} />
                </span>
              )}
            </li>
          ))}
        </ul>
      ),
    });
  }

  groups.push({
    type: "MERGE",
    title: "Merge account",
    summary: destinationAddress
      ? mediatorRequired
        ? "via relay account, 2 transactions"
        : "directly to your destination"
      : "Destination: to be entered",
    body: destinationAddress ? (
      <div className="space-y-1 text-xs text-fg-muted">
        <p>
          Destination:{" "}
          <FullAddress
            value={destinationAddress}
            label="destination address"
            className="text-white/70"
          />
        </p>
        {mediatorRequired ? (
          <p>
            Your destination is an exchange. The merge is routed through a shared relay account,
            which passes your funds on to the exchange, as a co-signed transfer. This is a second
            transaction after the cleanup.
          </p>
        ) : (
          <p>
            Your account is merged directly into the destination, removing it from the Stellar
            ledger.
          </p>
        )}
      </div>
    ) : (
      <p className="text-xs text-fg-muted">
        The destination is entered after every item above is decided.
      </p>
    ),
  });

  return (
    <Card className="divide-y divide-white/8 overflow-hidden">
      {groups.map((g) => {
        const isOpen = open === g.type;
        const chip: GroupChip = chips[g.type] ?? { kind: "informational" };
        return (
          <div key={g.type}>
            <button
              type="button"
              id={`${baseId}-${g.type}-header`}
              aria-controls={`${baseId}-${g.type}-panel`}
              onClick={() => onOpenChange(isOpen ? null : g.type)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.02] focus-visible:-outline-offset-2"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <StepTypeIcon type={g.type} className="h-4 w-4 shrink-0 text-accent/70" />
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium transition-colors ${
                      isOpen ? "text-white" : "text-white/80"
                    }`}
                  >
                    {g.title}
                  </span>
                  <span className="block truncate text-xs text-fg-subtle">{g.summary}</span>
                </span>
              </span>
              <span className="ml-auto shrink-0">
                <Badge tone={CHIP_TONE[chip.kind]}>{chipLabel(chip)}</Badge>
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-accent transition-transform duration-300 ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            <div
              id={`${baseId}-${g.type}-panel`}
              role="region"
              aria-labelledby={`${baseId}-${g.type}-header`}
              inert={!isOpen}
              className={`grid transition-all duration-300 ease-out ${
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <div className="px-4 pb-4">{g.body}</div>
              </div>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
