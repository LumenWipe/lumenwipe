"use client";

import { ExternalLink } from "lucide-react";
import { nodeAccessibleName, sceneOrder } from "@/lib/scene-model";
import { txExplorerUrl } from "@/lib/explorer";
import type { SceneNode } from "@/store/playground";
import KindIcon from "./KindIcon";

/** The scene's nodes as text, removed ones included, each with the transaction that removed it. */
export default function SceneList({
  nodes,
  label,
  className = "",
}: {
  nodes: readonly SceneNode[];
  label: string;
  className?: string;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul aria-label={label} className={`space-y-1.5 text-xs text-white/80 ${className}`}>
      {sceneOrder(nodes).map((node) => (
        <li key={node.id} className="flex items-center gap-2">
          <KindIcon kind={node.kind} className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1" data-scene-name>
            {nodeAccessibleName(node)}
          </span>
          {node.status === "destroyed" && node.txHash && (
            <a
              href={txExplorerUrl(node.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Transaction ${node.txHash.slice(0, 8)} in the explorer`}
              className="flex min-h-6 shrink-0 items-center gap-1 mkt-mono text-[10px] text-stellar hover:underline"
            >
              {node.txHash.slice(0, 8)}…
              <ExternalLink aria-hidden className="h-3 w-3" />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
