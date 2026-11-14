import { memoryKv } from "@/lib/kv";
import { selectionForMode } from "@/lib/mess-plan";
import {
  createSessionStore,
  sessionExpiresAt,
  type NewSessionData,
  type SessionStore,
} from "@/lib/session-store";

export interface FakeClock {
  now: () => number;
  advance: (ms: number) => void;
}

export function fakeClock(start = 1_800_000_000_000): FakeClock {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms) };
}

export function memoryStore(clock: FakeClock = fakeClock()): SessionStore {
  const kv = memoryKv(clock.now);
  return createSessionStore(() => kv);
}

export function newSessionData(): NewSessionData {
  return {
    demoPublic: "GDEMO",
    encDemoSecret: "enc",
    ephemeralIssuers: [],
    completedMessSteps: [],
    recordedSigners: [],
    demolishLog: [],
    demolishPending: null,
    demolishDone: false,
    selection: selectionForMode("light"),
    transferRecipient: null,
    helperAccounts: [],
    claimableBalances: [],
    allowances: [],
    exchange: null,
    expiresAt: sessionExpiresAt(Date.now()),
    extended: false,
  };
}

/** The reads only an exchange session's close makes, for a chain that closes into none. */
export const NO_EXCHANGE_READS = {
  nativeBalance: async (): Promise<string> => {
    throw new Error("This chain closes into no exchange");
  },
  ledgerTransaction: async (): Promise<null> => {
    throw new Error("This chain closes into no exchange");
  },
};

export function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
