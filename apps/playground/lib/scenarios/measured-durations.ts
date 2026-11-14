import type { MeasuredDurations } from "./durations";

// Written by scripts/durations.ts from nightly Playwright reports; never edited by hand.
export const MEASURED_DURATIONS: MeasuredDurations | null = {
  measuredAt: "2026-11-14",
  runs: ["43624429937"],
  units: {
    setup: { samples: 18, low: 1.9, high: 11.1 },
    classicStep: { samples: 34, low: 4.6, high: 5.4 },
    sorobanStep: { samples: 11, low: 4.3, high: 5.4 },
    closeRound: { samples: 32, low: 5.2, high: 14.5 },
  },
  coverage: { inside: 18, tests: 18 },
};
