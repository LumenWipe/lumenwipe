import type { MediatorCheckResult } from "@lumenwipe/types";

export function missingRequiredMemoError(
  check: Pick<MediatorCheckResult, "requiresMemo">,
  memo: string
): string | null {
  if (!check.requiresMemo || memo.trim() !== "") return null;
  return "This account says every payment to it needs a memo. Add the memo it gave you, such as an exchange deposit memo, before continuing.";
}
