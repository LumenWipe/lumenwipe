import { useState, type ComponentProps, type ReactElement } from "react";
import PlanAccordion from "@/components/plan/PlanAccordion";
import type { PlanGroupType } from "@/lib/plan/open-items";

type AccordionProps = ComponentProps<typeof PlanAccordion>;
type Props = Omit<
  AccordionProps,
  "open" | "onOpenChange" | "chips" | "onBulkSelectClaimableBalances" | "onUndoClaimableBalances"
> &
  Partial<
    Pick<AccordionProps, "chips" | "onBulkSelectClaimableBalances" | "onUndoClaimableBalances">
  > & { initialOpen?: PlanGroupType | null };

/** The plan accordion with its open group held the way the page holds it. */
export function StatefulPlanAccordion({
  initialOpen = "HANDLE_ASSETS",
  chips = {},
  onBulkSelectClaimableBalances = () => {},
  onUndoClaimableBalances = () => {},
  ...rest
}: Props): ReactElement {
  const [open, setOpen] = useState<PlanGroupType | null>(initialOpen);
  return (
    <PlanAccordion
      {...rest}
      open={open}
      onOpenChange={setOpen}
      chips={chips}
      onBulkSelectClaimableBalances={onBulkSelectClaimableBalances}
      onUndoClaimableBalances={onUndoClaimableBalances}
    />
  );
}
