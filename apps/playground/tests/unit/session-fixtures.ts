import { memoryKv } from "@/lib/kv";
import { createSessionStore, type NewSessionData, type SessionStore } from "@/lib/session-store";

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
    fundRareAssets: [],
    offerCount: 0,
    dataEntryCount: 0,
  };
}

export function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
