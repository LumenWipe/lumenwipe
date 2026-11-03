import { SE_EXPLORER_BASE, type Network } from "@/config/networks";
import { STEP_GROUP_LABELS } from "@/lib/plan/group-steps";
import type { ResumedClose } from "@/store/demolish";
import type { StepType } from "@/types/plan";
import { Callout } from "@/components/ui/callout";
import { formatStartedAt } from "@/components/execution/ResumeBanner";

/** What a resumed close already did, as this browser recorded it, above the fresh plan. */
export default function ResumedCloseNotice({
  resumed,
  network,
}: {
  resumed: ResumedClose;
  network: Network;
}) {
  const done = resumed.completedSteps;
  return (
    <Callout
      tone="info"
      announce="status"
      className="mb-4"
      title={`Continuing a close you started on ${formatStartedAt(resumed.startedAt)}`}
    >
      {done.length > 0 ? (
        <>
          <p>These transactions are confirmed, as recorded in this browser:</p>
          <ul className="mt-1 space-y-0.5">
            {done.map((step) => (
              <li key={step.txHash}>
                {STEP_GROUP_LABELS[step.type as StepType] ?? step.type}:{" "}
                <a
                  href={`${SE_EXPLORER_BASE[network]}/tx/${step.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all font-mono text-xs text-accent hover:underline"
                >
                  {step.txHash}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>This browser recorded no confirmed transaction for it.</p>
      )}
      <p className="mt-1">
        The account was read again just now, so the plan below lists only what is left on it.
      </p>
    </Callout>
  );
}
