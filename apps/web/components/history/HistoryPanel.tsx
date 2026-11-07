"use client";

import { useEffect, useRef, useState } from "react";
import { X, ExternalLink, Trash2, History } from "lucide-react";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import { listHistory, deleteHistoryEntry } from "@/lib/session/history";
import type { ReceiptRecord } from "@/types/history";
import { Dialog, DialogBody, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface HistoryPanelProps {
  onClose: () => void;
}

export default function HistoryPanel({ onClose }: HistoryPanelProps) {
  const [entries, setEntries] = useState<ReceiptRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    listHistory()
      .then((e) => {
        setEntries(e);
        setLoaded(true);
      })
      .catch((err) => {
        console.error("[history] load failed:", err);
        setLoaded(true);
      });
  }, []);

  async function handleDelete(id: string) {
    await deleteHistoryEntry(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setConfirmDelete(null);
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
        {!loaded && <p className="text-sm text-fg-muted text-center py-12">Loading…</p>}

        {loaded && entries.length === 0 && (
          <div className="text-center py-12 px-4">
            <History className="h-8 w-8 text-fg-muted/40 mx-auto mb-3" />
            <p className="text-sm text-fg-muted">No merges recorded yet.</p>
            <p className="text-xs text-fg-subtle mt-1">
              Completed account merges will appear here.
            </p>
          </div>
        )}

        {loaded &&
          entries.map((entry) => {
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
                    </p>
                    <p className="text-xs mkt-mono text-white/80 truncate">
                      {entry.sourceAddress.slice(0, 8)}…{entry.sourceAddress.slice(-6)}
                    </p>
                    <p className="text-xs text-fg-muted">
                      → {entry.destinationAddress.slice(0, 8)}…{entry.destinationAddress.slice(-6)}
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

                <p className="text-xs text-fg-muted">
                  Total fees: {entry.feeLumens === null ? "not recorded" : `${entry.feeLumens} XLM`}
                  {entry.mediatorRequired && " · used relay account"}
                </p>
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
