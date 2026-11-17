import type { useCloseExecution } from "@/hooks/useCloseExecution";

type CloseExecution = ReturnType<typeof useCloseExecution>;

/** An idle close: nothing running, nothing paused, and a pre-auth submission that is refused
 *  unless a test answers it. */
export function closeExecution(overrides: Partial<CloseExecution> = {}): CloseExecution {
  return {
    run: async () => {},
    progress: null,
    signatureStatus: null,
    cosign: null,
    importCosignResponse: () => null,
    discardCosignRound: () => {},
    signingPrompt: null,
    submitPreAuthTransaction: () =>
      Promise.reject(new Error("submitPreAuthTransaction is not stubbed")),
    checkUnconfirmed: async () => {},
    retrySafe: null,
    stillUnconfirmed: false,
    ...overrides,
  };
}
