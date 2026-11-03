import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ExecutePage from "@/app/[network]/execute/page";
import ReviewPage from "@/app/[network]/review/page";
import { routeForPhase, type CloseRoute } from "@/lib/plan/route-for-phase";
import * as sessionStore from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";
import type { DemolishPhase, PlannedStep } from "@/types/plan";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const STEP: PlannedStep = {
  index: 0,
  type: "MERGE",
  title: "MERGE",
  description: "",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
  txXdr: null,
  status: "pending",
  txHash: null,
  error: null,
};

const EXPECTED: Record<DemolishPhase, CloseRoute> = {
  IDLE: "analyze",
  ANALYZING: "analyze",
  SIGNER_SETUP: "analyze",
  ABORTED: "analyze",
  PREFLIGHT_COMPLETE: "review",
  STEP_EXECUTING: "execute",
  STEP_CONFIRMED: "execute",
  STEP_FAILED: "execute",
  STEP_UNCONFIRMED: "execute",
  COMPLETE: "complete",
};
const PHASES = Object.keys(EXPECTED) as DemolishPhase[];

const PAGES = { review: ReviewPage, execute: ExecutePage };
type GuardedPage = keyof typeof PAGES;

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

let replaced: string[];
let writes: ReturnType<typeof spyOn>[];

beforeEach(() => {
  replaced = [];
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({
        push: () => {},
        replace: (path: string) => replaced.push(path),
      }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  writes = [
    spyOn(sessionStore, "saveSession").mockImplementation(async () => {}),
    spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => true),
    spyOn(sessionStore, "deleteSession").mockImplementation(async () => {}),
    spyOn(sessionStore, "deleteSettledSession").mockImplementation(async () => true),
    spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {}),
  ];
});

afterEach(() => mock.restore());

/** Where landing on `page` in `phase` leaves the user: the page itself, or where its guard sends. */
async function land(page: GuardedPage, phase: DemolishPhase): Promise<string> {
  cleanup();
  replaced = [];
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan([STEP]);
  useDemolishStore.getState().setPhase(phase);
  const Page = PAGES[page];
  await act(async () => {
    render(<Page params={settled({ network: "testnet" as const })} />);
  });
  expect(useDemolishStore.getState().phase).toBe(phase);
  expect(replaced.length).toBeLessThanOrEqual(1);
  return replaced[0]?.replace("/testnet/", "") ?? page;
}

test("every phase belongs on exactly one page of the close", () => {
  for (const phase of PHASES) expect(routeForPhase(phase)).toBe(EXPECTED[phase]);
});

test("/review shows only a close waiting for its confirmation and sends the rest on", async () => {
  for (const phase of PHASES) expect(await land("review", phase)).toBe(EXPECTED[phase]);
});

test("/execute sends a close landing there to the page its phase belongs on", async () => {
  for (const phase of PHASES) expect(await land("execute", phase)).toBe(EXPECTED[phase]);
});

test("the review and execute guards agree, so no phase bounces between them", async () => {
  for (const phase of PHASES) {
    for (const start of ["review", "execute"] as const) {
      let at: string = start;
      for (let hop = 0; hop < 3 && at in PAGES; hop++) {
        const next = await land(at as GuardedPage, phase);
        if (next === at) break;
        at = next;
      }
      expect(at).toBe(EXPECTED[phase]);
      if (at in PAGES) expect(await land(at as GuardedPage, phase)).toBe(at);
    }
  }
});

test("the guards only redirect: no phase change and no saved-session write", async () => {
  for (const phase of PHASES) {
    await land("review", phase);
    await land("execute", phase);
  }
  for (const write of writes) expect(write).not.toHaveBeenCalled();
});
