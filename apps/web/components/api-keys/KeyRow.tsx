"use client";

import { RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { KeyListEntry } from "@/lib/integrator/client";

export const UNTITLED = "Untitled key";
export const USAGE_UNAVAILABLE = "Usage unavailable";

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A key limited to every network the API knows is shown as unscoped. */
export function scopeLabel(networks: readonly string[] | null | undefined): string {
  const scoped = new Set(networks ?? []);
  if (scoped.size === 1 && scoped.has("mainnet")) return "Mainnet only";
  if (scoped.size === 1 && scoped.has("testnet")) return "Testnet only";
  return "All networks";
}

export interface KeyRowProps {
  record: KeyListEntry;
  busy: boolean;
  confirming: boolean;
  onAskConfirm: () => void;
  onCancel: () => void;
  onRotate: () => void;
  onRevoke: () => void;
}

export default function KeyRow(props: KeyRowProps) {
  const { record, busy, confirming } = props;
  const name = record.label || UNTITLED;
  const created = formatDate(record.createdAt);
  // Two untitled keys read the same, so the button names the date and the id's start too.
  const manageName = `Manage ${name}, created ${created} (${record.id.slice(0, 8)})`;
  const usage = record.usage;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-1 text-xs">
        <p className="flex flex-wrap items-center gap-2">
          <span className="break-all text-sm font-medium text-fg">{name}</span>
          <Badge>{scopeLabel(record.networks)}</Badge>
        </p>
        <p className="text-fg-subtle">
          Created {created} ·{" "}
          {record.lastUsedAt ? (
            <>
              Last used{" "}
              <time dateTime={record.lastUsedAt}>{formatDateTime(record.lastUsedAt)}</time>
            </>
          ) : (
            "Never used"
          )}
        </p>
        <p className="text-fg-muted">
          {usage
            ? `${usage.today} today · ${usage.last30Days} in 30 days · ${usage.rateLimitedLast30Days} rate-limited`
            : USAGE_UNAVAILABLE}
        </p>
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-fg-muted">Revoke or rotate this key?</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            icon={<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />}
            onClick={props.onRotate}
          >
            Rotate
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
            onClick={props.onRevoke}
          >
            Revoke
          </Button>
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          aria-label={manageName}
          onClick={props.onAskConfirm}
        >
          Manage
        </Button>
      )}
    </li>
  );
}
