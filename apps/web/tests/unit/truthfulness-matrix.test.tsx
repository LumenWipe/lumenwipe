import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Suspense, type ReactElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import NetworkError from "@/app/[network]/error";
import HomePage from "@/app/[network]/page";
import CompletionReceipt from "@/components/complete/CompletionReceipt";
import ExecutionWizard from "@/components/execution/ExecutionWizard";
import ReviewView from "@/components/review/ReviewView";
import * as closeExecution from "@/hooks/useCloseExecution";
import * as sessionRecovery from "@/hooks/useSessionRecovery";
import * as walletKit from "@/hooks/useWalletKitConnection";
import { CLAIM_PATTERNS, allows, permittedClaims, type ClaimKey } from "@/lib/journey/claims";
import {
  deriveJourneyState,
  journeyOf,
  type Journey,
  type JourneyStateName,
} from "@/lib/journey/journey-state";
import * as closeRecord from "@/lib/session/close-record";
import * as history from "@/lib/session/history";
import * as recovery from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import { VerificationError } from "@/lib/stellar/verify";
import {
  ApiRequestError,
  closeFailureMessage,
  type CloseFailureStage,
} from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep, StepStatus, StepType } from "@/types/plan";
import type { SessionRecord } from "@/types/session";

// Every reassurance or success sentence the app can show, rendered on every screen that shows it
// in every journey state that screen can be reached in. A sentence matching a registered claim
// must be one its state allows, and each state's required statements must be there.

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const HASH = "c".repeat(64);
const SUBMISSION = { hash: HASH, covers: ["MERGE"], validUntil: 5 };

function step(index: number, type: StepType, status: StepStatus): PlannedStep {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash: status === "confirmed" ? `hash${index}` : null,
    error: null,
  };
}

const PENDING = [step(0, "CANCEL_OFFERS", "pending"), step(1, "MERGE", "pending")];
const PARTLY = [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "failed")];
const MERGED = [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "confirmed")];

type Store = Partial<ReturnType<typeof useDemolishStore.getState>>;

/** The store as each journey state leaves it. */
const STORE: Record<JourneyStateName, Store> = {
  untouched: { phase: "IDLE" },
  planned: { phase: "ANALYZING", executionPlan: PENDING },
  reviewed: { phase: "PREFLIGHT_COMPLETE", executionPlan: PENDING },
  signing: { phase: "STEP_EXECUTING", executionPlan: PENDING, sessionId: "s" },
  partial: { phase: "STEP_EXECUTING", executionPlan: PARTLY, sessionId: "s" },
  complete: { phase: "COMPLETE", executionPlan: MERGED, sessionId: "s" },
  unknown: { phase: "IDLE", sessionId: "s" },
};

/** A resumed close back on review: a record of an earlier run is saved, the plan is fresh. */
const RESUMED_REVIEW: Store = {
  phase: "PREFLIGHT_COMPLETE",
  executionPlan: PENDING,
  sessionId: "s",
};

function normalised(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function claimsIn(text: string): ClaimKey[] {
  const flat = normalised(text);
  return (Object.keys(CLAIM_PATTERNS) as ClaimKey[]).filter((c) => CLAIM_PATTERNS[c].test(flat));
}

/** The claims a rendered text makes that its journey does not allow. */
function claimViolations(text: string, journey: Journey): ClaimKey[] {
  return claimsIn(text).filter((claim) => !allows(journey, claim));
}

interface Cell {
  state: JourneyStateName;
  /** Seeds the store, then renders; returns the journey the rendered screen stands in. */
  show: () => Promise<Journey>;
  required: ClaimKey[];
}

interface Surface {
  name: string;
  cells: Cell[];
}

function seed(store: Store): void {
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.setState(store);
}

async function show(ui: ReactElement): Promise<void> {
  await act(async () => {
    render(ui);
  });
}

function storeJourney(): Journey {
  return journeyOf(useDemolishStore.getState());
}

let retrySafe: boolean | null = null;

function stubExecution(): void {
  spyOn(closeExecution, "useCloseExecution").mockImplementation(
    () =>
      ({
        run: async () => {},
        progressStatus: null,
        signatureStatus: null,
        submitPreAuthTransaction: async () => {},
        checkUnconfirmed: async () => {},
        retrySafe,
        stillUnconfirmed: false,
      }) as unknown as ReturnType<typeof closeExecution.useCloseExecution>
  );
  spyOn(walletKit, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address: null,
        connecting: false,
        error: null,
        networkMismatch: false,
        connect: async () => {},
        disconnect: async () => {},
      }) as unknown as ReturnType<typeof walletKit.useWalletKitConnection>
  );
}

function errorPage(state: JourneyStateName, required: ClaimKey[]): Cell {
  return {
    state,
    required,
    show: async () => {
      seed(STORE[state]);
      await show(<NetworkError error={new Error("boom")} reset={() => {}} />);
      return storeJourney();
    },
  };
}

function failure(
  state: "signing" | "partial" | "complete",
  err: unknown,
  stage: CloseFailureStage,
  required: ClaimKey[]
): Cell {
  return {
    state,
    required,
    show: async () => {
      seed({ ...STORE[state], phase: "STEP_FAILED" });
      const plan = useDemolishStore.getState().executionPlan;
      useDemolishStore.setState({ lastError: closeFailureMessage(err, stage, plan) });
      retrySafe = true;
      stubExecution();
      await show(<ExecutionWizard network="testnet" />);
      return storeJourney();
    },
  };
}

function executeSetup(state: "signing" | "partial", store: Store, required: ClaimKey[]): Cell {
  return {
    state,
    required,
    show: async () => {
      seed({ ...STORE[state], ...store });
      stubExecution();
      await show(<ExecutionWizard network="testnet" />);
      return storeJourney();
    },
  };
}

function review(state: "reviewed" | "unknown", hold?: () => void): Cell {
  return {
    state,
    required: hold ? ["each-tx-checked", "confirm-not-started"] : ["each-tx-checked"],
    show: async () => {
      seed(state === "reviewed" ? STORE.reviewed : RESUMED_REVIEW);
      spyOn(recovery, "readUnresolved").mockResolvedValue(null);
      spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
      hold?.();
      await show(<ReviewView network="testnet" />);
      const journey = storeJourney();
      if (hold) {
        fireEvent.click(screen.getByRole("checkbox"));
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /want to proceed/i }));
        });
      }
      return journey;
    },
  };
}

const HOLDS: Array<[string, () => void]> = [
  [
    "an unsettled hash",
    () => void spyOn(recovery, "readUnresolved").mockResolvedValue({} as SessionRecord),
  ],
  [
    "an unreadable saved state",
    () => void spyOn(recovery, "readUnresolved").mockRejectedValue(new Error("x")),
  ],
  [
    "a store that moved on",
    () => void spyOn(closeRecord, "saveCloseSession").mockResolvedValue(null),
  ],
  [
    "a save that fails",
    () => void spyOn(closeRecord, "saveCloseSession").mockRejectedValue(new Error("x")),
  ],
];

function receipt(state: "partial" | "complete", required: ClaimKey[]): Cell {
  return {
    state,
    required,
    show: async () => {
      seed({ ...STORE[state], phase: state === "partial" ? "STEP_FAILED" : "COMPLETE" });
      spyOn(history, "saveHistory").mockResolvedValue(undefined);
      spyOn(recovery, "cleanupSession").mockResolvedValue(undefined);
      await show(<CompletionReceipt network="testnet" />);
      return storeJourney();
    },
  };
}

function resumeBanner(record: Partial<SessionRecord>, required: ClaimKey[]): Cell {
  const session = {
    id: "s",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    mediatorRequired: false,
    completedSteps: [],
    currentStepIndex: 0,
    status: "in_progress",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...record,
  } as SessionRecord;
  return {
    state: "unknown",
    required,
    show: async () => {
      useDemolishStore.getState().reset();
      spyOn(sessionRecovery, "useSessionRecovery").mockImplementation(() => ({
        session,
        checked: true,
        clearSession: () => {},
        reload: async () => {},
      }));
      await show(
        <Suspense fallback={null}>
          <HomePage params={Promise.resolve({ network: "testnet" })} />
        </Suspense>
      );
      return deriveJourneyState({
        phase: "IDLE",
        plan: [],
        inFlight: session.unconfirmed !== undefined,
        saved: true,
      });
    },
  };
}

const declined = new Error("User declined access");
const mismatch = new VerificationError("op 2 pays to an unexpected destination");
const unavailable = new ApiRequestError(503, "");

const MATRIX: Surface[] = [
  {
    name: "route error page",
    cells: [
      errorPage("untouched", ["nothing-sent"]),
      errorPage("planned", ["nothing-sent"]),
      errorPage("reviewed", ["nothing-sent"]),
      errorPage("signing", ["may-be-sent"]),
      errorPage("partial", ["may-be-sent"]),
      errorPage("complete", ["may-be-sent"]),
      errorPage("unknown", ["may-be-sent"]),
    ],
  },
  {
    name: "execute failure panel",
    cells: [
      failure("signing", unavailable, "before-submit", ["no-new-sent", "safe-to-retry"]),
      failure("signing", unavailable, "submitted", ["safe-to-retry"]),
      failure("signing", unavailable, "refused", ["safe-to-retry"]),
      failure("partial", unavailable, "before-submit", [
        "no-new-sent",
        "still-open",
        "safe-to-retry",
      ]),
      failure("partial", unavailable, "submitted", ["still-open", "safe-to-retry"]),
      failure("complete", unavailable, "before-submit", ["account-closed"]),
    ],
  },
  {
    name: "wallet decline",
    cells: [
      failure("signing", declined, "before-submit", ["this-tx-not-sent", "safe-to-retry"]),
      failure("partial", declined, "before-submit", ["this-tx-not-sent", "still-open"]),
    ],
  },
  {
    name: "verification failure",
    cells: [
      failure("signing", mismatch, "before-submit", ["this-tx-not-sent", "safe-to-retry"]),
      failure("partial", mismatch, "before-submit", ["this-tx-not-sent", "still-open"]),
    ],
  },
  {
    name: "unconfirmed panel",
    cells: (["signing", "partial"] as const).map((state) =>
      executeSetup(
        state,
        { phase: "STEP_UNCONFIRMED", unconfirmedSubmission: SUBMISSION as never },
        ["may-be-sent"]
      )
    ),
  },
  {
    name: "execute trust note",
    cells: [
      executeSetup("signing", {}, ["each-tx-checked"]),
      executeSetup("partial", {}, ["each-tx-checked"]),
    ],
  },
  {
    name: "review trust note",
    cells: [review("reviewed"), review("unknown")],
  },
  {
    name: "confirm hold",
    cells: HOLDS.flatMap(([, hold]) => [review("reviewed", hold), review("unknown", hold)]),
  },
  {
    name: "receipt banner",
    cells: [receipt("partial", ["still-open"]), receipt("complete", ["account-closed"])],
  },
  {
    name: "resume banner",
    cells: [
      resumeBanner({}, []),
      resumeBanner({ unconfirmed: { hash: HASH, covers: ["MERGE"], validUntil: 5 } }, [
        "may-be-sent",
      ]),
    ],
  },
];

beforeEach(() => {
  useNetworkStore.setState({ network: "testnet" });
  retrySafe = null;
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(navigation, "useParams").mockImplementation((() => ({
    network: "testnet",
  })) as typeof navigation.useParams);
  spyOn(navigation, "useRouter").mockImplementation(
    () => ({ push: () => {}, replace: () => {} }) as never
  );
  spyOn(navigation, "useSearchParams").mockImplementation(() => new URLSearchParams() as never);
  spyOn(sessionStore, "listSessions").mockResolvedValue([]);
  spyOn(sessionStore, "loadSession").mockResolvedValue(undefined as never);
  spyOn(sessionStore, "saveSession").mockResolvedValue(undefined);
});

afterEach(() => mock.restore());

describe("truthfulness matrix", () => {
  const cells = MATRIX.flatMap((surface) =>
    surface.cells.map((cell, i) => ({ label: `${surface.name} #${i + 1} (${cell.state})`, cell }))
  );

  test.each(cells)("$label", async ({ cell }) => {
    const journey = await cell.show();
    const text = document.body.textContent ?? "";
    expect(journey.state).toBe(cell.state);
    expect(claimViolations(text, journey)).toEqual([]);
    for (const claim of cell.required) expect(claimsIn(text)).toContain(claim);
  });

  test("every journey state is rendered on the route error page", () => {
    const states = new Set(MATRIX[0]!.cells.map((c) => c.state));
    expect(states.size).toBe(7);
  });

  test("a claim shown in a state that does not allow it is caught", () => {
    const signing = deriveJourneyState({
      phase: "STEP_EXECUTING",
      plan: PENDING,
      inFlight: false,
      saved: true,
    });
    expect(claimViolations("An error occurred. Nothing has been signed or sent.", signing)).toEqual(
      ["nothing-sent"]
    );
    expect(permittedClaims(signing)).not.toContain("nothing-sent");
  });
});

// A claim string in the source is either shown on a surface the matrix renders, or named here
// with the reason it stands outside a close. A new one anywhere fails until it is one or the
// other, and the count catches a second copy added beside a known one.
const WEB = join(import.meta.dir, "..", "..");
const SCANNED = ["app", "components", "hooks", "lib"];
const EXEMPT = [join(WEB, "lib", "journey")];

type Site = { count: number; shownBy: string };

const OUTSIDE = {
  marketing: "marketing copy describing the product, not a close in progress",
  allowances: "the allowance revoke flow, which is not a close",
  lookup: "the home page reporting the outcome a hash lookup just returned",
  connect: "a wallet connection request, which signs nothing",
  unused: "an error class nothing throws",
  notFound: "the 404 page, which plays on the close as a metaphor",
} as const;

const SANCTIONED: Record<string, Partial<Record<ClaimKey, Site>>> = {
  "app/[network]/error.tsx": {
    "may-be-sent": { count: 1, shownBy: "route error page" },
    "nothing-sent": { count: 1, shownBy: "route error page" },
  },
  "app/not-found.tsx": {
    "account-closed": { count: 1, shownBy: OUTSIDE.notFound },
  },
  "components/complete/CompletionReceipt.tsx": {
    "account-closed": { count: 5, shownBy: "receipt banner" },
    "still-open": { count: 1, shownBy: "receipt banner" },
  },
  "components/execution/ExecutionWizard.tsx": {
    "each-tx-checked": { count: 1, shownBy: "execute trust note" },
    "safe-to-retry": { count: 1, shownBy: "execute failure panel" },
  },
  "components/review/ReviewView.tsx": {
    "each-tx-checked": { count: 1, shownBy: "review trust note" },
  },
  "components/marketing/ExecutionPlanDemo.tsx": {
    "account-closed": { count: 1, shownBy: OUTSIDE.marketing },
  },
  "hooks/useCloseExecution.ts": {
    "may-be-sent": { count: 1, shownBy: "execute failure panel" },
  },
  "lib/stellar/signing-guards.ts": {
    "this-tx-not-sent": { count: 1, shownBy: "execute failure panel" },
  },
  "lib/utils/errors.ts": {
    "safe-to-retry": { count: 1, shownBy: OUTSIDE.unused },
  },
  "lib/utils/user-error.ts": {
    "nothing-sent": { count: 2, shownBy: `${OUTSIDE.connect}; ${OUTSIDE.allowances}` },
    "this-tx-not-sent": { count: 2, shownBy: "wallet decline" },
    "may-be-sent": { count: 1, shownBy: "unconfirmed panel" },
    "account-closed": { count: 2, shownBy: `execute failure panel; ${OUTSIDE.lookup}` },
    "no-new-sent": { count: 2, shownBy: "execute failure panel" },
    "confirm-not-started": { count: 4, shownBy: "confirm hold" },
    "still-open": { count: 1, shownBy: "execute failure panel" },
    "safe-to-retry": { count: 3, shownBy: "execute failure panel" },
  },
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (EXEMPT.includes(path)) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Source as it reads on screen: no comments, JSX spacing and entities resolved. */
function readable(source: string): string {
  return normalised(
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1")
      .replace(/\{" "\}/g, " ")
      .replace(/&apos;/g, "'")
  );
}

function claimCounts(text: string): Partial<Record<ClaimKey, number>> {
  const counts: Partial<Record<ClaimKey, number>> = {};
  for (const claim of Object.keys(CLAIM_PATTERNS) as ClaimKey[]) {
    const global = new RegExp(CLAIM_PATTERNS[claim].source, "gi");
    const found = text.match(global)?.length ?? 0;
    if (found > 0) counts[claim] = found;
  }
  return counts;
}

describe("claim strings in the source", () => {
  const found: Record<string, Partial<Record<ClaimKey, number>>> = {};
  for (const file of SCANNED.flatMap((dir) => sourceFiles(join(WEB, dir)))) {
    const counts = claimCounts(readable(readFileSync(file, "utf8")));
    if (Object.keys(counts).length > 0) found[relative(WEB, file)] = counts;
  }

  test("every claim string is sanctioned, and only those", () => {
    const sanctioned = Object.fromEntries(
      Object.entries(SANCTIONED).map(([file, sites]) => [
        file,
        Object.fromEntries(Object.entries(sites).map(([claim, site]) => [claim, site!.count])),
      ])
    );
    expect(found).toEqual(sanctioned);
  });

  test("every sanctioned site names a rendered surface or why it is outside a close", () => {
    const surfaces = new Set(MATRIX.map((s) => s.name));
    const reasons = new Set<string>(Object.values(OUTSIDE));
    for (const sites of Object.values(SANCTIONED)) {
      for (const site of Object.values(sites)) {
        for (const part of site!.shownBy.split("; ")) {
          expect(surfaces.has(part) || reasons.has(part)).toBe(true);
        }
      }
    }
  });

  test("a new claim string fails the scan", () => {
    expect(claimCounts(readable('<p>Your funds are safe{" "}here.</p>'))).toEqual({
      "funds-safe": 1,
    });
  });
});
