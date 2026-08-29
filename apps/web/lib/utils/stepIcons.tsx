import {
  KeyRound,
  Database,
  BarChart2,
  Link2,
  Target,
  ArrowLeftRight,
  Unlink,
  GitMerge,
  ShieldOff,
} from "lucide-react";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  NORMALIZE_SIGNERS: KeyRound,
  REVOKE_SPONSORSHIP: ShieldOff,
  REMOVE_DATA_ENTRIES: Database,
  CANCEL_OFFERS: BarChart2,
  ADD_TRUSTLINE_FOR_CLAIM: Link2,
  CLAIM_BALANCES: Target,
  HANDLE_ASSETS: ArrowLeftRight,
  REMOVE_TRUSTLINES: Unlink,
  MERGE: GitMerge,
  CLOSE_ACCOUNT: GitMerge,
};

export function StepTypeIcon({
  type,
  className = "h-4 w-4",
}: {
  type: string;
  className?: string;
}) {
  const Icon = ICON_MAP[type];
  if (!Icon) return null;
  return <Icon className={className} />;
}
