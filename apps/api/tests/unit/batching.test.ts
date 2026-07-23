import { test, expect } from "bun:test";
import { batchItems } from "@/lib/stellar/tx-builder/batching";

test("batchItems › empty array → empty result", () => {
  expect(batchItems([], 100)).toEqual([]);
});

test("batchItems › 1 item → 1 batch of 1", () => {
  const result = batchItems(["x"], 100);
  expect(result).toHaveLength(1);
  expect(result[0]).toHaveLength(1);
});

test("batchItems › 100 items → 1 batch of 100", () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const result = batchItems(items, 100);
  expect(result).toHaveLength(1);
  expect(result[0]).toHaveLength(100);
});

test("batchItems › 101 items → 2 batches (100, 1)", () => {
  const items = Array.from({ length: 101 }, (_, i) => i);
  const result = batchItems(items, 100);
  expect(result).toHaveLength(2);
  expect(result[0]).toHaveLength(100);
  expect(result[1]).toHaveLength(1);
});

test("batchItems › 250 items → 3 batches (100, 100, 50)", () => {
  const items = Array.from({ length: 250 }, (_, i) => i);
  const result = batchItems(items, 100);
  expect(result).toHaveLength(3);
  expect(result[0]).toHaveLength(100);
  expect(result[1]).toHaveLength(100);
  expect(result[2]).toHaveLength(50);
});

test("batchItems › uses default OP_BATCH_LIMIT (100)", () => {
  const items = Array.from({ length: 150 }, (_, i) => i);
  const result = batchItems(items);
  expect(result).toHaveLength(2);
  expect(result[0]).toHaveLength(100);
  expect(result[1]).toHaveLength(50);
});

test("batchItems › preserves item order", () => {
  const items = [1, 2, 3, 4, 5];
  const result = batchItems(items, 3);
  expect(result[0]).toEqual([1, 2, 3]);
  expect(result[1]).toEqual([4, 5]);
});

test("batchItems › custom limit smaller than item count", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  const result = batchItems(items, 3);
  expect(result).toHaveLength(4);
  expect(result[3]).toHaveLength(1);
});
