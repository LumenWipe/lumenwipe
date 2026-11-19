import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { EstimateError, fetchEstimate, type EstimateFailure } from "@/lib/api/estimate-client";

// The English text each failure showed before the reasons moved into the locale dictionary.
const ENGLISH: Record<EstimateFailure, string> = {
  invalid: "Enter a valid Stellar account address.",
  missing: "No account with this address exists on this network, so there is nothing to recover.",
  limited: "Too many estimates from this connection today. You can still continue to close.",
  unreadable:
    "We couldn't read this account right now, so there is no estimate. Try again in a moment, or continue to close.",
};

afterEach(() => mock.restore());

async function failureFor(status: number): Promise<EstimateError> {
  spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({}, { status })) as never);
  const error = await fetchEstimate("mainnet", "G").catch((e: unknown) => e);
  if (!(error instanceof EstimateError)) throw new Error("expected an EstimateError");
  return error;
}

test("each status the route answers with is a reason with the English text it always had", async () => {
  const cases: [number, EstimateFailure][] = [
    [400, "invalid"],
    [404, "missing"],
    [429, "limited"],
    [500, "unreadable"],
  ];
  for (const [status, reason] of cases) {
    const error = await failureFor(status);
    expect(error.reason).toBe(reason);
    expect(error.message).toBe(ENGLISH[reason]);
  }
});
