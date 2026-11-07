"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, ExternalLink, Trash2, History, AlertTriangle } from "lucide-react";
import Link from "next/link";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import { listHistory, deleteHistoryEntry } from "@/lib/session/history";
import { receiptPath } from "@/lib/receipt/href";
import { formatXlm } from "@/lib/utils/amounts";
import { shortAddr } from "@/lib/utils/short-id";
import type { ReceiptRecord } from "@/types/history";
import { Dialog, DialogBody, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface HistoryPanelProps {
  onClose: () => void;
}

type Load =
  { state: "loading" } | { state: "error" } | { state: "ready"; entries: ReceiptRecord[] };

export default function HistoryPanel({ onClose }: HistoryPanelProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteFailed, setDeleteFailed] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const read = useCallback(() => {
    setLoad({ state: "loading" });
    listHistory().then(
      (entries) => setLoad({ state: "ready", entries }),
      (err: unknown) => {
        console.error("[history] load failed:", err);
        setLoad({ state: "error" });
      }
    );
  }, []);

  useEffect(read, [read]);

  async function handleDelete(id: string) {
    setConfirmDelete(null);
    try {
      await deleteHistoryEntry(id);
    } catch (err) {
      console.error("[history] delete failed:", err);
      setDeleteFailed(id);
      return;
    }
    setDeleteFailed(null);
    setLoad((prev) =>
      prev.state === "ready"
        ? { state: "ready", entries: prev.entries.filter((e) => e.id !== id) }
        : prev
    );
  }

  return (
    <Dialog side="right" onClose={onClose} initialFocusRef={closeRef}>
      <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-accent" />
          <DialogTitle className="mkt-display font-bold text-base text-white">
            Merge history
          </DialogTitle>
        </div>
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close"
          className="text-fg-muted hover:text-white transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <DialogBody>
        {load.state === "loading" && (
          <p className="text-sm text-fg-muted text-center py-12">Loading…</p>
        )}

        {load.state === "error" && (
          <div role="alert" className="text-center py-12 px-4 space-y-3">
            <AlertTriangle className="h-8 w-8 text-warning mx-auto" />
            <p className="text-sm text-white/85">The history could not be read in this browser.</p>
            <p className="text-xs text-fg-subtle">
              Storage may be blocked, as in some private windows. Any receipts saved here are not
              known until it can be read.
            </p>
            <button onClick={read} className="text-xs text-accent hover:underline">
              Try again
            </button>
          </div>
        )}

        {load.state === "ready" && load.entries.length === 0 && (
          <div className="text-center py-12 px-4">
            <History className="h-8 w-8 text-fg-muted/40 mx-auto mb-3" />
            <p className="text-sm text-fg-muted">No merges recorded yet.</p>
            <p className="text-xs text-fg-subtle mt-1">
              Completed account merges will appear here.
            </p>
          </div>
        )}

        {load.state === "ready" &&
          load.entries.map((entry) => {
            const explorerBase = SE_EXPLORER_BASE[entry.network];
            const svExplorerBase = SV_EXPLORER_BASE[entry.network];
            const date = new Date(entry.completedAt).toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
            });

            return (
              <div key={entry.id} className="border-b border-white/8 px-4 py-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs text-fg-muted mb-1">
                      {date} · {entry.network}
                      {entry.outcome === "incomplete" && " · not finished"}
                    </p>
                    <p className="text-xs font-mono-address text-white/80 truncate">
                      {shortAddr(entry.sourceAddress)}
                    </p>
                    <p className="text-xs font-mono-address text-fg-muted truncate">
                      → {shortAddr(entry.destinationAddress)}
                    </p>
                  </div>

                  {confirmDelete === entry.id ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className="text-xs text-danger-fg hover:underline"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="text-xs text-fg-muted hover:underline"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(entry.id)}
                      aria-label="Delete entry"
                      className="text-fg-muted hover:text-danger-fg transition-colors shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {deleteFailed === entry.id && (
                  <p role="alert" className="text-xs text-danger-fg">
                    This entry could not be deleted, so it is still saved in this browser. Try
                    again.
                  </p>
                )}

                <p className="text-xs text-fg-muted">
                  Amount received:{" "}
                  <span className="text-white/80">
                    {entry.receivedLumens === null
                      ? "not recorded"
                      : formatXlm(entry.receivedLumens)}
                  </span>
                </p>

                <div className="space-y-1">
                  {entry.transactions.map((receipt) => (
                    <div key={receipt.txHash} className="flex items-center justify-between text-xs">
                      <span className="text-fg-muted truncate max-w-[140px]">{receipt.label}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        <a
                          href={`${explorerBase}/tx/${receipt.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-accent hover:underline"
                        >
                          SE <ExternalLink className="h-3 w-3" />
                        </a>
                        <a
                          href={`${svExplorerBase}/tx/${receipt.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-accent hover:underline"
                        >
                          SV <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 text-xs">
                  <p className="text-fg-muted">
                    Total fees:{" "}
                    {entry.feeLumens === null ? "not recorded" : formatXlm(entry.feeLumens)}
                    {entry.mediatorRequired && " · used relay account"}
                  </p>
                  <Link
                    href={receiptPath(entry.network, entry.id)}
                    onClick={onClose}
                    className="shrink-0 text-accent hover:underline"
                  >
                    Open receipt<span className="sr-only"> of {date}</span>
                  </Link>
                </div>
              </div>
            );
          })}
      </DialogBody>

      <div className="border-t border-white/10 px-4 py-3">
        <DialogDescription className="text-xs text-fg-muted">
          History is stored locally in your browser and never leaves your device.
        </DialogDescription>
      </div>
    </Dialog>
  );
}
