import { RECORD_VERSION, type SessionRecord } from "@/types/session";

/** An in-progress session that has confirmed no step yet. */
export function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: RECORD_VERSION,
    id: "session",
    network: "testnet",
    sourceAddress: "",
    destinationAddress: "",
    memo: null,
    memoType: null,
    mediatorRequired: false,
    completedSteps: [],
    currentStepIndex: 0,
    stepCount: null,
    stepBase: 0,
    status: "in_progress",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
