import { expect, test } from "bun:test";
import { REQUEST_DEADLINE_MS } from "@/config/constants";
import { DEFAULT_TIMEOUT_MS } from "../../../../packages/sdk/src/http";

/** Time for the API to send its answer once its own deadline has passed. */
const RESPONSE_MARGIN_MS = 5_000;

// Raising the deadline past the SDK's default would turn the API's typed 503 into a client timeout.
test("the SDK's default timeout outlasts the request deadline", () => {
  expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(REQUEST_DEADLINE_MS + RESPONSE_MARGIN_MS);
});
