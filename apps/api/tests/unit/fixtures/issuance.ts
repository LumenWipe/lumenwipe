import { spyOn } from "bun:test";
import * as issuance from "@/lib/close-api/issuance-preflight";

/** Answers the supply read with "issues nothing", so a test that is not about issuance needs no
 *  provider. Undone by `mock.restore()`. */
export function stubIssuance(summary: issuance.IssuanceSummary | null = null): void {
  spyOn(issuance, "assessIssuance").mockResolvedValue(summary);
}
