import type { ExpectedReceive, ExitTargetRef } from "@/lib/plan/expected-receive";
import { formatStroops } from "@/lib/api/plan-adapters";
import { PROTOCOL_LABELS } from "@/lib/plan/describe-position";
import { shortAddr } from "@/lib/utils/short-id";

/** The figure as shown: never below zero, with a flag for when the fees are more than the
 *  balance would cover. */
export function receiveFigure(expected: ExpectedReceive): { xlm: string; feesExceed: boolean } {
  const negative = expected.totalStroops.startsWith("-");
  return { xlm: negative ? "0" : formatStroops(expected.totalStroops), feesExceed: negative };
}

export const FEES_EXCEED_BALANCE =
  "The estimated network fees are more than this account's balance would cover, so nothing may arrive.";

export function estimateNote(expected: ExpectedReceive): string {
  const parts = ["An estimate, after network fees."];
  if (expected.estimated) parts.push("It counts the least each chosen swap may deliver.");
  if (expected.unquotedSwaps > 0) {
    parts.push(
      expected.unquotedSwaps === 1
        ? "It leaves out one swap that has no estimate."
        : `It leaves out ${expected.unquotedSwaps} swaps that have no estimate.`
    );
  }
  if (expected.flaggedSwaps > 0) {
    parts.push(
      expected.flaggedSwaps === 1
        ? "One swap you confirmed was flagged on its card: it may deliver much less than the current market price suggests."
        : `${expected.flaggedSwaps} swaps you confirmed were flagged on their cards: they may deliver much less than the current market price suggests.`
    );
  }
  if (expected.uncomputedExits.length > 0) {
    parts.push(`It leaves out what exiting ${exitNames(expected.uncomputedExits)} pays out.`);
  } else if (expected.leavesOutDefiExits) {
    parts.push("It leaves out any XLM that exiting your DeFi positions pays out.");
  }
  return parts.join(" ");
}

function exitNames(exits: readonly ExitTargetRef[]): string {
  const names = exits.map(
    ({ protocol, contract }) =>
      `the ${PROTOCOL_LABELS[protocol]} position in ${shortAddr(contract)}`
  );
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function signedLine(stroops: string): string {
  return stroops.startsWith("-")
    ? `- ${formatStroops(stroops.slice(1))} XLM`
    : `+ ${formatStroops(stroops)} XLM`;
}

interface ExpectedReceiveBreakdownProps {
  expected: ExpectedReceive;
  /** Adds a closing line with the total the lines add up to. */
  showTotal?: boolean;
}

/** The lines the expected figure is the sum of, in stroops. */
export function ExpectedReceiveBreakdown({
  expected,
  showTotal = false,
}: ExpectedReceiveBreakdownProps) {
  const lines = [
    { label: "XLM balance", value: `${formatStroops(expected.balanceStroops)} XLM` },
    { label: "Network fees", value: `- ${formatStroops(expected.feeStroops)} XLM` },
    ...(expected.swapStroops !== "0"
      ? [{ label: "Swaps to XLM, at least", value: `+ ${formatStroops(expected.swapStroops)} XLM` }]
      : []),
    ...(expected.exitStroops !== "0"
      ? [{ label: "DeFi exits, at least", value: signedLine(expected.exitStroops) }]
      : []),
    ...(expected.claimStroops !== "0"
      ? [{ label: "XLM claimed", value: `+ ${formatStroops(expected.claimStroops)} XLM` }]
      : []),
  ];

  return (
    <dl className="space-y-1 text-xs">
      {lines.map(({ label, value }) => (
        <div key={label} className="flex justify-between gap-3">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="mkt-mono text-white/80">{value}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-3 pl-3">
        <dt className="text-fg-subtle">of which locked in reserves</dt>
        <dd className="mkt-mono text-fg-subtle">{formatStroops(expected.reserveStroops)} XLM</dd>
      </div>
      {showTotal && (
        <div
          className="flex justify-between gap-3 border-t border-white/10 pt-1"
          data-testid="net-estimate-total"
        >
          <dt className="font-medium text-white/80">You will receive about</dt>
          <dd className="mkt-mono font-semibold text-value">{receiveFigure(expected).xlm} XLM</dd>
        </div>
      )}
    </dl>
  );
}
