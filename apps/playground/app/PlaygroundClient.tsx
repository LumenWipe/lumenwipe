"use client";

import { useLayoutEffect } from "react";
import { usePlaygroundStore } from "@/store/playground";
import { decodeSelection, parseBatchSize, parseUnavailable } from "@/lib/scenarios";
import { replaySeed } from "@/components/scene/ScenarioPicker";
import { playgroundRequest } from "@/lib/playground-api";
import { usePlaygroundExecution } from "@/hooks/usePlaygroundExecution";
import { useBatchExecution } from "@/hooks/useBatchExecution";
import BatchPanel from "@/components/scene/BatchPanel";
import OrbitalScene from "@/components/scene/OrbitalScene";
import PlaygroundControls from "@/components/scene/PlaygroundControls";
import TxLogPanel from "@/components/scene/TxLogPanel";
import SdkSnippetPanel from "@/components/scene/SdkSnippetPanel";
import ReceiptPanel from "@/components/scene/ReceiptPanel";

export default function PlaygroundClient() {
  const { start, demolish, resolve, progressStatus } = usePlaygroundExecution();
  const batchRun = useBatchExecution();
  const phase = usePlaygroundStore((s) => s.phase);
  const batch = usePlaygroundStore((s) => s.batch);

  // Until this answers, every scenario shows as available; the create route checks again anyway.
  // A shared link then restores its wallet: `?seed=` replays a code, `?selection=` an exact
  // selection (validated again when the run starts). Create stays disabled until the link is
  // applied, set before the first paint so no click can start the default selection meanwhile.
  // `?batch=2` or `?batch=3` opens on a batch of that size.
  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const batchSize = parseBatchSize(params.get("batch"));
    if (batchSize) usePlaygroundStore.getState().setBatchSize(batchSize);
    if (params.has("seed") || params.has("selection")) {
      usePlaygroundStore.getState().setLinkPending(true);
    }
    playgroundRequest<unknown>(fetch, "/scenarios")
      .then((body) => usePlaygroundStore.getState().setUnavailable(parseUnavailable(body)))
      .catch(() => {})
      .finally(() => {
        const seed = params.get("seed");
        const shared = decodeSelection(params.get("selection") ?? "");
        if (seed) replaySeed(seed);
        else if (shared) usePlaygroundStore.getState().setSelection(shared, null);
        usePlaygroundStore.getState().setLinkPending(false);
      });
  }, []);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-24 pt-16 sm:px-6">
      <div className="mb-10 max-w-2xl">
        <p className="mkt-eyebrow mb-3 text-stellar">Testnet playground</p>
        <h1 className="mkt-display text-4xl text-white sm:text-5xl">
          Trash an account. Then watch it vanish.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-white/85">
          Everything here happens on the Stellar testnet with a throwaway demo account - no wallet,
          no risk, real transactions. Every animation is backed by an on-chain transaction you can
          verify in the explorer.
        </p>
      </div>

      {/* The controls come first in the page, so on a phone they sit above the scene and focus
          reaches them first; from lg the grid puts them in the right-hand column. */}
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-2 lg:row-start-1">
          <PlaygroundControls
            start={start}
            demolish={demolish}
            resolve={resolve}
            startBatch={batchRun.startBatch}
            closeBatch={batchRun.closeBatch}
            progressStatus={batchRun.progressStatus ?? progressStatus}
          />
          <TxLogPanel />
        </div>

        <div className="mkt-panel relative min-w-0 overflow-hidden rounded-lg p-4 sm:p-8 lg:col-start-1 lg:row-start-1">
          {batch ? <BatchPanel onResolve={batchRun.resolveMember} /> : <OrbitalScene />}
        </div>
      </div>

      {phase === "COMPLETE" ? <ReceiptPanel /> : <SdkSnippetPanel />}

      {phase === "IDLE" && (
        <p className="mt-8 text-center text-sm text-white/50">
          Nothing on this page is stored beyond your session - the demo account is deleted after it
          closes, or after an hour of inactivity.
        </p>
      )}
    </section>
  );
}
