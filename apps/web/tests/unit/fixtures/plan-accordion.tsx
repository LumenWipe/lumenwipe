import { useState, type ComponentProps, type ReactElement } from "react";
import PlanAccordion from "@/components/plan/PlanAccordion";
import type { PlanGroupType } from "@/lib/plan/open-items";

type Props = Omit<ComponentProps<typeof PlanAccordion>, "open" | "onOpenChange" | "chips"> & {
  initialOpen?: PlanGroupType | null;
  chips?: ComponentProps<typeof PlanAccordion>["chips"];
};

/** The plan accordion with its open group held the way the page holds it. */
export function StatefulPlanAccordion({
  initialOpen = "HANDLE_ASSETS",
  chips = {},
  ...rest
}: Props): ReactElement {
  const [open, setOpen] = useState<PlanGroupType | null>(initialOpen);
  return <PlanAccordion {...rest} open={open} onOpenChange={setOpen} chips={chips} />;
}
