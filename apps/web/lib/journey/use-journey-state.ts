"use client";

import { useMemo } from "react";
import { useDemolishStore } from "@/store/demolish";
import { journeyOf, type Journey } from "./journey-state";

export function useJourneyState(): Journey {
  const phase = useDemolishStore((s) => s.phase);
  const executionPlan = useDemolishStore((s) => s.executionPlan);
  const unconfirmedSubmission = useDemolishStore((s) => s.unconfirmedSubmission);
  const sessionId = useDemolishStore((s) => s.sessionId);
  return useMemo(
    () => journeyOf({ phase, executionPlan, unconfirmedSubmission, sessionId }),
    [phase, executionPlan, unconfirmedSubmission, sessionId]
  );
}
