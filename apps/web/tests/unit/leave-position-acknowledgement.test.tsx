import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlanResponse } from "@lumenwipe/sdk";
import LeavePositionAcknowledgement from "@/components/plan/LeavePositionAcknowledgement";
import { positionsLeftBehindToDecisions } from "@/lib/api/close-decisions";
import { decisionPointsToLeavablePositions, type LeavablePosition } from "@/lib/api/plan-adapters";
import { proceedError } from "@/lib/plan/resolvable-blockers";
import { useDemolishStore } from "@/store/demolish";

afterEach(() => {
  cleanup();
  useDemolishStore.getState().reset();
});

const SOURCE = "GSOURCE0000000000000000000000000000000000000000000000000";
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const ID = `defi_leave:${SOURCE}:${POOL}`;

const position: LeavablePosition = {
  decisionId: ID,
  protocol: "Blend",
  contract: POOL,
  usdValue: "25.00",
  reason: "Simulating the withdraw of this Blend position failed on the network.",
  note: "I choose to close this account without exiting this blend position (about $25.00).",
};

test("names the position and its value, and reports the choice when ticked", () => {
  const onChange = mock(() => {});
  render(
    <LeavePositionAcknowledgement
      position={position}
      leftBehind={false}
      onLeftBehindChange={onChange}
    />
  );
  expect(screen.getByText(/Blend CCEB…4HGF position \(about \$25\.00\)/)).toBeDefined();
  expect(screen.getByText(/failed on the network/)).toBeDefined();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onChange).toHaveBeenCalledWith(true);
});

test("an unpriced position says its value is unknown, and the choice can be undone", () => {
  const onChange = mock(() => {});
  render(
    <LeavePositionAcknowledgement
      position={{ ...position, usdValue: null }}
      leftBehind
      onLeftBehindChange={onChange}
    />
  );
  expect(screen.getByText(/value unknown/)).toBeDefined();
  const box = screen.getByRole("checkbox") as HTMLInputElement;
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  expect(onChange).toHaveBeenCalledWith(false);
});

test("only answers naming the account being closed are sent", () => {
  expect(positionsLeftBehindToDecisions([ID], SOURCE)).toEqual([
    { id: ID, choice: "leave_position_behind" },
  ]);
  expect(positionsLeftBehindToDecisions([ID], "GOTHER")).toEqual([]);
  expect(positionsLeftBehindToDecisions([`defi_leave:${SOURCE}:nope`], SOURCE)).toEqual([]);
});

test("the plan's leave decisions become cards; anything malformed is dropped", () => {
  const plan = {
    decisionPoints: [
      {
        id: ID,
        type: "confirmation",
        subject: {
          kind: "defi_position_leave",
          protocol: "blend",
          label: "Blend",
          contract: POOL,
          usdValue: "25.00",
          reason: position.reason,
        },
        options: [{ id: "leave_position_behind", note: position.note }],
        default: "",
        required: true,
      },
      {
        id: `defi_leave:${SOURCE}:bad`,
        type: "confirmation",
        subject: { kind: "defi_position_leave", contract: "bad" },
        options: [{ id: "leave_position_behind", note: "x" }],
        default: "",
        required: true,
      },
      {
        id: `issuer_supply:${SOURCE}`,
        type: "confirmation",
        subject: { kind: "issuer_supply" },
        options: [{ id: "stranding_holders_acknowledged" }],
        default: "",
        required: true,
      },
    ],
  } as unknown as PlanResponse;
  expect(decisionPointsToLeavablePositions(plan)).toEqual([position]);
});

test("a position left behind is a recorded warning, not something that stops the close", () => {
  expect(
    proceedError([{ code: "defi_position_left_behind", message: "You chose to leave it." }])
  ).toBeNull();
  expect(proceedError([{ code: "exit_simulation_failed", message: "Cannot exit." }])).toBe(
    "Cannot exit."
  );
});

test("the store records and clears each choice by its own id", () => {
  const { setPositionLeftBehind } = useDemolishStore.getState();
  setPositionLeftBehind(ID, true);
  setPositionLeftBehind(ID, true);
  expect(useDemolishStore.getState().positionsLeftBehind).toEqual([ID]);
  setPositionLeftBehind(ID, false);
  expect(useDemolishStore.getState().positionsLeftBehind).toEqual([]);
});

test("a choice the latest plan no longer offers is dropped, so it cannot outlive its card", () => {
  const other = `defi_leave:${SOURCE}:CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4`;
  const { setPositionLeftBehind, prunePositionsLeftBehind } = useDemolishStore.getState();
  setPositionLeftBehind(ID, true);
  setPositionLeftBehind(other, true);
  prunePositionsLeftBehind([ID]);
  expect(useDemolishStore.getState().positionsLeftBehind).toEqual([ID]);
  prunePositionsLeftBehind([]);
  expect(useDemolishStore.getState().positionsLeftBehind).toEqual([]);
});
