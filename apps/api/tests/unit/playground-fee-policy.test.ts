import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_FEE_STROOPS, MAX_FEE_BUMP_STROOPS } from "@/config/constants";

// The fee sponsor's policy as a fixture apps/playground's unit tests pin its own copies to
// (apps/playground/tests/unit/fee-policy.test.ts): the playground never imports the API, and checks
// the sponsor's envelope against this ceiling. A change here fails until the fixture is
// regenerated, and the regenerated fixture then fails the playground until it follows.
//
// Regenerate: UPDATE_PLAYGROUND_RECIPE=1 bun test tests/unit/playground-fee-policy.test.ts, then
// bun run format from the repository root.

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../playground/tests/fixtures/api-fee-policy.json", import.meta.url)
);
const UPDATE = process.env.UPDATE_PLAYGROUND_RECIPE === "1";

test("the fee sponsor's policy is the one in apps/playground's fixture", () => {
  const fixture = { baseFeeStroops: BASE_FEE_STROOPS, maxFeeBumpStroops: MAX_FEE_BUMP_STROOPS };
  if (UPDATE) writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  expect(existsSync(FIXTURE_PATH)).toBe(true);
  expect(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))).toEqual(fixture);
});
