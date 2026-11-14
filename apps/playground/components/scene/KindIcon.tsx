import {
  ArrowLeftRight,
  CircleDot,
  Database,
  Gem,
  Gift,
  HandCoins,
  Handshake,
  KeyRound,
  Layers,
  Users,
} from "lucide-react";
import type { SceneNodeKind } from "@/store/playground";

const KIND_ICON: Record<SceneNodeKind, typeof Gem> = {
  signer: KeyRound,
  multisig: Users,
  trustline: Gem,
  data: Database,
  offer: ArrowLeftRight,
  generic: CircleDot,
  position: Layers,
  allowance: HandCoins,
  claimable: Gift,
  sponsorship: Handshake,
};

/** The kind's colour token, for a fill, a stroke or an icon. */
export const kindColor = (kind: SceneNodeKind): string => `hsl(var(--kind-${kind}))`;

/** The kind's icon in its own colour; decorative, since every use names the kind in text. */
export default function KindIcon({
  kind,
  className = "h-3 w-3",
}: {
  kind: SceneNodeKind;
  className?: string;
}) {
  const Icon = KIND_ICON[kind] ?? CircleDot;
  return (
    <Icon aria-hidden className={`shrink-0 ${className}`} style={{ color: kindColor(kind) }} />
  );
}
