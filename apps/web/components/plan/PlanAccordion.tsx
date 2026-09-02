"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { AccountState, DefiPosition, UnrecognizedDefiPosition } from "@/types/account";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import { formatAsset } from "@/lib/utils/assets";
import AssetDispositionCard from "./AssetDispositionCard";
import ClaimableBalanceCard from "./ClaimableBalanceCard";

interface PlanAccordionProps {
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
  claimableBalanceDecisions: ClaimableBalanceDecision[];
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>;
  onSelectClaimableBalance: (balanceId: string, selection: ClaimableBalanceSelection) => void;
  /** Set once the destination is entered; the merge group shows it. */
  destinationAddress: string | null;
  mediatorRequired: boolean;
}

type GroupType =
  | "NORMALIZE_SIGNERS"
  | "REVOKE_SPONSORSHIP"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "CLAIM_BALANCES"
  | "DEFI_POSITIONS"
  | "HANDLE_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "MERGE";

interface Group {
  type: GroupType;
  title: string;
  summary: string;
  body: React.ReactNode;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

const PROTOCOL_LABELS: Record<DefiPosition["protocol"], string> = {
  blend: "Blend",
  aquarius: "Aquarius",
  soroswap: "Soroswap",
  phoenix: "Phoenix",
  fxdao: "FxDAO",
};

function symbolFor(
  address: string,
  enrichment: AccountState["defiPositions"]["enrichment"]
): string {
  return enrichment[address]?.symbol ?? shortAddr(address);
}

/** Describes what's held, not a computed user-facing balance - Blend's bToken/dToken amounts
 *  are interest-bearing share counts, not the underlying asset amount, so this reports what the
 *  provider returned rather than implying a conversion this section doesn't perform (that's the
 *  exit adapters epic's job, per the issue's "no exit action here" note). */
function describeDefiPosition(
  position: DefiPosition,
  enrichment: AccountState["defiPositions"]["enrichment"]
): string {
  const protocol = PROTOCOL_LABELS[position.protocol];
  switch (position.positionType) {
    case "supply":
      return `${protocol} supply · ${symbolFor(position.assetAddress, enrichment)}${
        position.isBackstop ? " (backstop)" : ""
      }`;
    case "borrow":
      return `${protocol} borrow · ${symbolFor(position.assetAddress, enrichment)}`;
    case "lp":
      return `${protocol} LP position · ${position.shareAmount} shares`;
    case "stake":
      return `${protocol} stake · ${position.stakedAmount}`;
    case "cdp":
      return `${protocol} vault · ${position.denomination} · collateral ${position.collateralAmount}, debt ${position.debtAmount}`;
  }
}

export default function PlanAccordion({
  account,
  conversions,
  assetDispositions,
  transferDestinations,
  mergeDestination,
  onSetDisposition,
  onSetTransferDestination,
  claimableBalanceDecisions,
  claimableBalanceSelections,
  onSelectClaimableBalance,
  destinationAddress,
  mediatorRequired,
}: PlanAccordionProps) {
  const [open, setOpen] = useState<GroupType | null>("HANDLE_ASSETS");

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
            <li key={s.key} className="font-mono-address text-xs text-white/55">
              {shortAddr(s.key)} <span className="text-white/35">· weight {s.weight}</span>
            </li>
          ))}
          {extraSigners.length === 0 && (
            <li className="text-xs text-white/55">Reset authorization thresholds to single-key.</li>
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
            <li key={i} className="text-xs text-white/55">
              {entry.kind === "trustline" && `Trustline for ${entry.asset.split(":")[0]}`}
              {entry.kind === "offer" && `Offer ${entry.offerId}`}
              {entry.kind === "data_entry" && `Data entry "${entry.name}"`}
              {entry.kind === "signer" && "Signer"}
              {entry.kind === "account" && "Account creation"}{" "}
              <span className="font-mono-address text-white/35">on {shortAddr(entry.owner)}</span>
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
            <li key={d.key} className="font-mono text-xs text-white/55 truncate">
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
            <li key={o.id} className="text-xs text-white/55">
              <span className="text-white/70">{o.amount}</span> {formatAsset(o.selling)}{" "}
              <span className="text-white/35">→</span> {formatAsset(o.buying)}{" "}
              <span className="text-white/35">@ {o.price}</span>
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
        <div className="space-y-2">
          {claimableBalanceDecisions.map((b) => (
            <ClaimableBalanceCard
              key={b.balanceId}
              item={b}
              selection={claimableBalanceSelections[b.balanceId]}
              onSelect={onSelectClaimableBalance}
            />
          ))}
        </div>
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
                <li key={i} className="text-xs text-white/55">
                  {describeDefiPosition(p, account.defiPositions.enrichment)}
                  {p.usdValue && <span className="text-white/35"> · ≈ ${p.usdValue}</span>}
                </li>
              ))}
            </ul>
          )}
          {unrecognizedPositions.length > 0 && (
            <ul className="space-y-1">
              {unrecognizedPositions.map((u: UnrecognizedDefiPosition, i) => (
                <li key={i} className="text-xs text-amber-400/80">
                  {PROTOCOL_LABELS[u.protocol]} position could not be read ({u.reason}) - verify
                  manually.
                </li>
              ))}
            </ul>
          )}
          {defiWarnings.length > 0 && (
            <ul className="space-y-1">
              {defiWarnings.map((w, i) => (
                <li key={i} className="text-xs text-amber-400/80">
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
            <AssetDispositionCard
              key={c.asset}
              item={c}
              disposition={assetDispositions[c.asset]}
              transferDestination={transferDestinations[c.asset]}
              mergeDestination={mergeDestination}
              onSetDisposition={onSetDisposition}
              onSetTransferDestination={onSetTransferDestination}
            />
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
            <li key={tl.asset} className="text-xs text-white/55">
              {tl.code} <span className="text-white/35">· balance {tl.balance}</span>
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
        ? "via intermediary, 2 transactions"
        : `to ${shortAddr(destinationAddress)}`
      : "Destination: to be entered",
    body: destinationAddress ? (
      <div className="space-y-1 text-xs text-white/55">
        <p>
          Destination:{" "}
          <span className="font-mono-address text-white/70">{shortAddr(destinationAddress)}</span>
        </p>
        {mediatorRequired ? (
          <p>
            Your destination is an exchange. The merge is routed through a shared intermediary
            account as a co-signed transfer. This is a second transaction after the cleanup.
          </p>
        ) : (
          <p>
            Your account is merged directly into the destination, removing it from the Stellar
            ledger.
          </p>
        )}
      </div>
    ) : (
      <p className="text-xs text-white/55">
        The destination is entered after every asset above is resolved.
      </p>
    ),
  });

  return (
    <div className="divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/10 bg-[hsl(var(--card)/0.6)]">
      {groups.map((g) => {
        const isOpen = open === g.type;
        return (
          <div key={g.type}>
            <button
              onClick={() => setOpen(isOpen ? null : g.type)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-white/[0.02]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <StepTypeIcon type={g.type} className="h-4 w-4 shrink-0 text-stellar/70" />
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium transition-colors ${
                      isOpen ? "text-white" : "text-white/80"
                    }`}
                  >
                    {g.title}
                  </span>
                  <span className="block truncate text-xs text-white/45">{g.summary}</span>
                </span>
              </span>
              <Plus
                className={`h-4 w-4 shrink-0 text-stellar transition-transform duration-300 ${
                  isOpen ? "rotate-45" : ""
                }`}
              />
            </button>
            <div
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
    </div>
  );
}
