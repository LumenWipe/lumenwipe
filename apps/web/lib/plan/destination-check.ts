import type { Network } from "@/config/networks";
import { mediatorAllowedFor } from "@/lib/exchange-registry";
import { missingRequiredMemoError } from "@/lib/plan/memo-requirement";
import { readApiError } from "@/lib/utils/user-error";
import type { MediatorCheckResult } from "@/types/account";

/**
 * Why a close may not go ahead to this destination, or null when nothing stops it.
 *
 * The route behind this is cached, so its answer may stop a close and may never supply a value:
 * this returns only a refusal, and what gets signed comes from the user and the bundled registry.
 */
export async function destinationRefusal(
  network: Network,
  destination: string,
  memo: string
): Promise<string | null> {
  const res = await fetch(`/api/${network}/mediator/check/${destination}`);
  if (!res.ok) throw await readApiError(res);
  const check = (await res.json()) as MediatorCheckResult;
  const needsMediator = check.requiresMediator ?? false;

  // The browser decides the hand-off from its own bundled registry; an answer that disagrees
  // stops here rather than at signing.
  if (needsMediator !== mediatorAllowedFor(destination, network)) {
    return "The rules for this destination could not be confirmed. Refresh the page and try again. If it keeps happening, close to a personal Stellar wallet you control and send to the exchange from there.";
  }

  // Exchange destinations go through the shared mediator. If the API can't co-sign it (no
  // mediator configured), stop here - before the user enters a key or signs - rather than
  // failing at execution time.
  if (needsMediator && check.available === false) {
    return "Sending your balance straight to this exchange isn't available right now. Instead, merge to a personal Stellar wallet you control, then send it to the exchange from there - remember to include the exchange's deposit memo, or it won't be credited.";
  }

  return missingRequiredMemoError(check, memo);
}
