import {
  KeyRound,
  Database,
  BarChart2,
  Target,
  ArrowLeftRight,
  Unlink,
  GitMerge,
} from "lucide-react";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  NORMALIZE_SIGNERS: KeyRound,
  REMOVE_DATA_ENTRIES: Database,
  CANCEL_OFFERS: BarChart2,
  CLAIM_BALANCES: Target,
  CONVERT_ASSETS: ArrowLeftRight,
  REMOVE_TRUSTLINES: Unlink,
  MERGE: GitMerge,
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
