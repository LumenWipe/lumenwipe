"use client";

import { useCallback, useRef, useState } from "react";
import {
  usePlaygroundStore,
  type BatchMember,
  type BatchPlanLine,
  type StoppedClose,
} from "@/store/playground";
import { DEFAULT_BATCH_MEMBERS } from "@/lib/scenarios";
import { GENERIC_ERROR_COPY } from "@/lib/error-copy";
import {
  DecisionBlockedError,
  PlanBlockedError,
  PlaygroundApiError,
  SessionExpiredError,
} from "@/lib/playground-api";
import {
  api,
  DEMOLISH_MAX_ROUNDS,
  type DemolishRoundResponse,
  type SessionResponse,
} from "./usePlaygroundExecution";

// The batch close, driven from the browser one member at a time through each member's own session
// routes: its mess, then one read-only plan for every member, then each member's close. A member
// that stops (a blocker, a failed round) is reported in its row and the next one still runs.

interface BatchResponse {
  batchId: string;
  blockedIndex: number;
  expiresAt: number;
  members: (SessionResponse & { label: string })[];
}

interface BatchPlanResponse {
  results: ({ index: number; address: string } & BatchPlanLine)[];
}

export interface UseBatchExecutionResult {
  startBatch: () => void;
  closeBatch: () => void;
  resolveMember: (index: number, blocker: string) => void;
  progressStatus: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** How a member's close stopped, as its row shows it. */
export function stoppedMember(err: unknown): Pick<BatchMember, "close" | "stop" | "message"> {
  if (err instanceof PlanBlockedError) {
    const stop: StoppedClose = {
      decisionIds: [],
      blockers: err.blockers,
      resolvable: err.resolvable,
    };
    return { close: "blocked", stop, message: err.message };
  }
  if (err instanceof DecisionBlockedError) {
    return {
      close: "blocked",
      stop: { decisionIds: err.decisionIds, blockers: [], resolvable: [] },
      message: err.message,
    };
  }
  return {
    close: "failed",
    stop: null,
    message: err instanceof PlaygroundApiError ? err.message : GENERIC_ERROR_COPY,
  };
}

export function useBatchExecution(): UseBatchExecutionResult {
  const [progressStatus, setProgressStatus] = useState<string | null>(null);
  const running = useRef(false);

  const fail = useCallback((err: unknown) => {
    const store = usePlaygroundStore.getState();
    if (err instanceof SessionExpiredError) {
      store.setPhase("EXPIRED");
      return;
    }
    if (!(err instanceof PlaygroundApiError)) console.error("[playground] unexpected error:", err);
    store.setLastError(err instanceof PlaygroundApiError ? err.message : GENERIC_ERROR_COPY);
    store.setPhase("ERROR");
  }, []);

  /** Creates the members, runs each one's mess, then plans them all in one call. */
  const startBatch = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const store = usePlaygroundStore.getState();
    const size = store.batchSize === 3 ? 3 : 2;
    try {
      store.reset();
      store.setPhase("MESSING");
      setProgressStatus(`Creating & funding ${size} demo accounts...`);
      const created = await api<BatchResponse>("/batch", {
        method: "POST",
        body: JSON.stringify({ members: DEFAULT_BATCH_MEMBERS[size] }),
      });
      usePlaygroundStore.getState().startBatch(
        {
          batchId: created.batchId,
          blockedIndex: created.blockedIndex,
          members: created.members.map((m) => ({
            sessionId: m.sessionId,
            demoPublic: m.demoPublic,
            label: m.label,
            messPlan: m.messPlan,
            messDone: 0,
            plan: null,
            close: "waiting",
            stop: null,
            message: null,
            hashes: [],
          })),
        },
        created.expiresAt
      );

      for (const [index, member] of created.members.entries()) {
        const n = index + 1;
        usePlaygroundStore.getState().addLog({
          label: `Account ${n}: demo account funded, ${member.demoPublic.slice(0, 8)}…`,
          txHash: null,
          kind: "info",
        });
        for (const [i, step] of member.messPlan.entries()) {
          setProgressStatus(`Account ${n}: ${step.label}`);
          const { txHash } = await api<{ txHash: string | null }>(
            `/session/${member.sessionId}/mess`,
            { method: "POST", body: JSON.stringify({ stepId: step.id }) }
          );
          const now = usePlaygroundStore.getState();
          now.addLog({
            label: `Account ${n}: ${step.label}`,
            txHash,
            kind: txHash === null ? "info" : "mess",
          });
          now.updateBatchMember(index, { messDone: i + 1 });
        }
      }

      setProgressStatus("Planning every account with one call to the LumenWipe API...");
      const { results } = await api<BatchPlanResponse>(`/batch/${created.batchId}/plan`);
      for (const { index, status, blockers } of results) {
        usePlaygroundStore.getState().updateBatchMember(index, { plan: { status, blockers } });
      }
      const blocked = results.filter((r) => r.status === "blocked").length;
      usePlaygroundStore.getState().addLog({
        label: `Batch plan: ${results.length - blocked} of ${results.length} accounts can close, ${blocked} blocked`,
        txHash: null,
        kind: "info",
      });
      usePlaygroundStore.getState().setPhase("DIRTY");

      // Best effort: without it the page only leaves out the code panel.
      api<unknown>(`/batch/${created.batchId}/sdk-snippet`)
        .then((body) => {
          const now = usePlaygroundStore.getState();
          const snippet = isRecord(body) ? body.snippet : null;
          if (typeof snippet === "string" && now.batch?.batchId === created.batchId) {
            now.setSdkSnippet(snippet);
          }
        })
        .catch(() => {});
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [fail]);

  /** Runs one member's close to its merge, or records how it stopped. */
  const closeMember = useCallback(async (index: number) => {
    const member = usePlaygroundStore.getState().batch?.members[index];
    if (!member) return;
    const n = index + 1;
    const { updateBatchMember } = usePlaygroundStore.getState();
    updateBatchMember(index, { close: "closing", stop: null, message: null });
    try {
      for (let round = 0; ; round++) {
        if (round === DEMOLISH_MAX_ROUNDS) throw new Error("The close did not converge");
        setProgressStatus(`Account ${n}: closing, round ${round + 1}...`);
        const result = await api<DemolishRoundResponse>(
          `/session/${member.sessionId}/demolish/round`,
          { method: "POST" }
        );
        for (const entry of result.confirmed) {
          const now = usePlaygroundStore.getState();
          now.addLog({
            label: `Account ${n}: ${entry.summary}`,
            txHash: entry.hash,
            kind: "demolish",
          });
          const hashes = now.batch?.members[index]?.hashes ?? [];
          if (!hashes.includes(entry.hash)) {
            updateBatchMember(index, { hashes: [...hashes, entry.hash] });
          }
        }
        if (result.done) break;
      }
      updateBatchMember(index, { close: "closed" });
      fetch(`/api/session/${member.sessionId}/cleanup`, { method: "POST" }).catch((err) =>
        console.error("[playground] cleanup request failed:", err)
      );
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      if (!(err instanceof PlaygroundApiError))
        console.error("[playground] unexpected error:", err);
      updateBatchMember(index, stoppedMember(err));
    }
  }, []);

  /** Closes every member not closed yet, one after another. */
  const closeBatch = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const store = usePlaygroundStore.getState();
      store.setLastError(null);
      store.setPhase("DEMOLISHING");
      const members = store.batch?.members ?? [];
      for (const [index, member] of members.entries()) {
        if (member.close === "closed") continue;
        await closeMember(index);
      }
      usePlaygroundStore.getState().setPhase("COMPLETE");
    } catch (err) {
      fail(err);
    } finally {
      setProgressStatus(null);
      running.current = false;
    }
  }, [closeMember, fail]);

  /** Runs a member's planned fix for its blocker, then its close again. */
  const resolveMember = useCallback(
    async (index: number, blocker: string) => {
      const member = usePlaygroundStore.getState().batch?.members[index];
      if (!member || running.current) return;
      running.current = true;
      setProgressStatus(`Account ${index + 1}: clearing the blocker...`);
      try {
        await api<{ ok: true }>(`/session/${member.sessionId}/resolve`, {
          method: "POST",
          body: JSON.stringify({ blocker }),
        });
        await closeMember(index);
      } catch (err) {
        if (err instanceof SessionExpiredError) fail(err);
        else usePlaygroundStore.getState().updateBatchMember(index, stoppedMember(err));
      } finally {
        setProgressStatus(null);
        running.current = false;
      }
    },
    [closeMember, fail]
  );

  return { startBatch, closeBatch, resolveMember, progressStatus };
}
