import { describe, expect, test } from "bun:test";
import { percentile, splitColdWarm, summarize } from "../src/stats";

describe("percentile", () => {
  test("is nearest-rank, so it is always a measured value", () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  test("is null with no sample", () => {
    expect(percentile([], 50)).toBeNull();
    expect(summarize([])).toEqual({ n: 0, p50: null, p95: null });
  });
});

describe("splitColdWarm", () => {
  test("takes the first request of each round as cold and the rest as warm", () => {
    const { cold, warm } = splitColdWarm([
      [900, 100, 110, 120, 130],
      [800, 140, 150, 160, 170],
    ]);
    expect(cold).toEqual({ n: 2, p50: 800, p95: 900 });
    expect(warm.n).toBe(8);
    expect(warm.p50).toBe(130);
    expect(warm.p95).toBe(170);
  });

  test("never counts a warm request as cold when the first one failed", () => {
    const { cold, warm } = splitColdWarm([[null, 100, 110, 120, 130]]);
    expect(cold.n).toBe(0);
    expect(warm).toEqual({ n: 4, p50: 110, p95: 130 });
  });
});
