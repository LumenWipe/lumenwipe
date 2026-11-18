import { expect, test } from "bun:test";
import {
  FEATURE_SETS,
  parseUnavailable,
  presetSelection,
  type FeatureSetId,
} from "@/lib/scenarios";
import { BASE_URL, runCycle } from "./cycle";

// Manual only, gated like full-cycle.integration.test.ts: every feature set's preset, as the
// running playground offers it, through one demo's whole life on testnet. A preset this
// deployment can run none of is passed over; a run that passes over all of them fails.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const ran = new Set<FeatureSetId>();

for (const set of FEATURE_SETS) {
  test.skipIf(!RUN_INTEGRATION)(
    `the ${set.label} preset closes end to end`,
    async () => {
      const res = await fetch(`${BASE_URL}/api/scenarios`);
      expect(res.ok).toBe(true);
      const selection = presetSelection(set.id, {
        unavailable: parseUnavailable(await res.json()),
      });
      if (!selection) return;
      await runCycle({ selection });
      ran.add(set.id);
    },
    600_000
  );
}

test.skipIf(!RUN_INTEGRATION)("at least one preset ran", () => {
  expect(ran.size).toBeGreaterThan(0);
});
