"use client";

import { useEffect, useState } from "react";
import { X, ExternalLink, Trash2, History } from "lucide-react";
import { SE_EXPLORER_BASE, SV_EXPLORER_BASE } from "@/config/networks";
import { listHistory, deleteHistoryEntry } from "@/lib/session/history";
import type { MergeHistoryEntry } from "@/types/history";

interface HistoryPanelProps {
  onClose: () => void;
}

export default function HistoryPanel({ onClose }: HistoryPanelProps) {
  const [entries, setEntries] = useState<MergeHistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    listHistory().then((e) => {
      setEntries(e);
      setLoaded(true);
    });
  }, []);

  async function handleDelete(id: string) {
    await deleteHistoryEntry(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setConfirmDelete(null);
  }

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-sm bg-[#0a0a10] border-l border-white/10 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-stellar" />
            <h2 className="mkt-display font-bold text-base text-white">Merge history</h2>
          </div>
          <button
            onClick={onClose}
            className="text-white/50 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!loaded && <p className="text-sm text-muted-foreground text-center py-12">Loading…</p>}

          {loaded && entries.length === 0 && (
            <div className="text-center py-12 px-4">
              <History className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No merges recorded yet.</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
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
                      <p className="text-xs text-muted-foreground mb-1">
                        {date} · {entry.network}
                      </p>
                      <p className="text-xs mkt-mono text-white/80 truncate">
                        {entry.sourceAddress.slice(0, 8)}…{entry.sourceAddress.slice(-6)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        → {entry.destinationAddress.slice(0, 8)}…
                        {entry.destinationAddress.slice(-6)}
                      </p>
                    </div>

                    {confirmDelete === entry.id ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleDelete(entry.id)}
                          className="text-xs text-destructive hover:underline"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="text-xs text-muted-foreground hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(entry.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="space-y-1">
                    {entry.txReceipts.map((receipt) => (
                      <div
                        key={receipt.txHash}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-muted-foreground truncate max-w-[140px]">
                          {receipt.title}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <a
                            href={`${explorerBase}/tx/${receipt.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-stellar hover:underline"
                          >
                            SE <ExternalLink className="h-3 w-3" />
                          </a>
                          <a
                            href={`${svExplorerBase}/tx/${receipt.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-stellar hover:underline"
                          >
                            SV <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Total fees: {entry.totalFeeLumens} XLM
                    {entry.usedMediator && " · used intermediary"}
                  </p>
                </div>
              );
            })}
        </div>

        <div className="border-t border-white/10 px-4 py-3">
          <p className="text-xs text-white/50">
            History is stored locally in your browser and never leaves your device.
          </p>
        </div>
      </div>
    </>
  );
}
