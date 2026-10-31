import { spyOn } from "bun:test";
import * as stateDrift from "@/lib/close-api/state-drift";

/** Builds on whatever sequence the test's stub server reports, without confirming any entry, so a
 *  test that is not about drift needs no ledger fake. Undone by `mock.restore()`. */
export function stubLedgerConfirmation(): void {
  spyOn(stateDrift, "confirmLedgerState").mockImplementation(async (state, server) => {
    const stub = server as { getAccount?: (id: string) => Promise<{ sequenceNumber(): string }> };
    return stub.getAccount
      ? (await stub.getAccount(state.address)).sequenceNumber()
      : state.sequence;
  });
}
