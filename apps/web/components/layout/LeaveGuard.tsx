"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { exitRuleOf, type ExitRule } from "@/lib/journey/exit-rule";
import { useJourneyState } from "@/lib/journey/use-journey-state";
import { useDemolishStore } from "@/store/demolish";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

export const LEAVE_CLOSE = "A close is in progress. Leaving stops signing; you can resume later.";
export const LEAVE_CLOSE_IN_FLIGHT =
  "A transaction of this close may still be on its way to the network. Leaving signs nothing more, and the start page checks its outcome when you come back.";

interface LeaveRequest {
  leave: () => void;
  stay?: () => void;
}

interface LeaveGuard {
  rule: ExitRule;
  /** Runs `leave` at once while leaving is free; otherwise asks first. A confirmed leave ends
   *  this tab's close before `leave` runs, so the loop signs and sends nothing more for it. */
  requestLeave: (request: LeaveRequest) => void;
  /** Asks, then goes to `href`, while a close is in progress. */
  requestLeaveTo: (href: string) => void;
}

const FREE: LeaveGuard = {
  rule: { leave: "free", inFlight: false, back: "analyze", warnOnUnload: false },
  requestLeave: ({ leave }) => leave(),
  requestLeaveTo: () => {},
};

const LeaveContext = createContext<LeaveGuard>(FREE);

export function useLeaveGuard(): LeaveGuard {
  return useContext(LeaveContext);
}

function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

/** Applies the exit rule to every way out of a close this tab can catch: in-app links, the
 *  execute page's back control, a network change and the tab closing. */
export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const journey = useJourneyState();
  const signingRun = useDemolishStore((s) => s.signingRun);
  const reset = useDemolishStore((s) => s.reset);
  const rule = useMemo(() => exitRuleOf(journey, signingRun), [journey, signingRun]);
  const [asking, setAsking] = useState<LeaveRequest | null>(null);
  const [leaving, setLeaving] = useState<LeaveRequest | null>(null);

  useEffect(() => {
    if (!rule.warnOnUnload) return;
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [rule.warnOnUnload]);

  // Runs after the pages under this one have reacted to the reset, so a page sending an emptied
  // close elsewhere never overrides where the person chose to go.
  useEffect(() => {
    if (!leaving) return;
    setLeaving(null);
    leaving.leave();
  }, [leaving]);

  const requestLeave = useCallback(
    (request: LeaveRequest) => {
      if (rule.leave === "free") request.leave();
      else setAsking(request);
    },
    [rule.leave]
  );

  const stay = useCallback(() => {
    asking?.stay?.();
    setAsking(null);
  }, [asking]);

  function confirm(): void {
    const request = asking;
    setAsking(null);
    reset();
    setLeaving(request);
  }

  const guard = useMemo(
    () => ({
      rule,
      requestLeave,
      requestLeaveTo: (href: string) => requestLeave({ leave: () => router.push(href) }),
    }),
    [rule, requestLeave, router]
  );

  return (
    <LeaveContext.Provider value={guard}>
      {children}
      {asking && (
        <Dialog onClose={stay}>
          <div className="space-y-2 px-5 pt-5">
            <DialogTitle className="text-base font-semibold text-white">
              Leave this close?
            </DialogTitle>
            <DialogDescription className="text-sm text-fg-muted">
              {rule.inFlight ? LEAVE_CLOSE_IN_FLIGHT : LEAVE_CLOSE}
            </DialogDescription>
          </div>
          <DialogFooter className="px-5 py-4 sm:justify-end">
            <Button variant="secondary" onClick={stay}>
              Stay
            </Button>
            <Button variant="danger" onClick={confirm}>
              Leave
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </LeaveContext.Provider>
  );
}

/** A plain link while leaving is free; one that asks first while a close is in progress. */
export function LeaveLink({
  href,
  onClick,
  ...rest
}: ComponentProps<typeof Link> & { href: string }) {
  const { rule, requestLeaveTo } = useLeaveGuard();
  return (
    <Link
      {...rest}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (rule.leave === "free" || event.defaultPrevented) return;
        // A new tab or window leaves this one where it is.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        requestLeaveTo(href);
      }}
    />
  );
}
