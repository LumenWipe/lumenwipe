import { expect, test } from "bun:test";
import { closingHashes, readReceived } from "@/lib/receipt/received";
import { formatLumensExact, stroopsToFixedLumens } from "@/lib/utils/amounts";
import type { ReceiptRecord, ReceiptTransaction } from "@/types/history";
import { RECORD_VERSION } from "@/types/session";

const DEST = "GDESTINATION000000000000000000000000000000000000000000000";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const asked = { destination: DEST, hashes: [A, B] };

function tx(txHash: string, stepTypes: string[]): ReceiptTransaction {
  return { txHash, label: stepTypes[0], stepTypes, stepTitles: stepTypes };
}

function record(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    version: RECORD_VERSION,
    id: "r-1",
    network: "testnet",
    sourceAddress: "GSOURCE",
    destinationAddress: DEST,
    mediatorRequired: false,
    outcome: "closed",
    completedAt: "2026-11-07T10:30:00.000Z",
    memo: null,
    transactions: [tx(C, ["CANCEL_OFFERS"]), tx(A, ["MERGE"])],
    groups: null,
    feeLumens: null,
    receivedLumens: null,
    ...over,
  };
}

function delivered(hash: string, amountStroops: string) {
  return { hash, status: "delivered", ledger: 7, amountStroops };
}

const answer = {
  destination: DEST,
  entries: [delivered(A, "100000000"), delivered(B, "23400000")],
  totalStroops: "123400000",
};

test("only the transactions that carried the merge are asked about", () => {
  expect(closingHashes(record())).toEqual([A]);
  expect(
    closingHashes(
      record({
        transactions: [tx(A.toUpperCase(), ["HANDLE_ASSETS", "CLOSE_ACCOUNT"]), tx(B, ["MERGE"])],
      })
    )
  ).toEqual([A, B]);
  expect(closingHashes(record({ transactions: [tx(A, ["MERGE"]), tx(A, ["MERGE"])] }))).toEqual([
    A,
  ]);
});

test("nothing is asked about when no merge confirmed or its hash is not one", () => {
  const six = Array.from({ length: 6 }, (_, i) => tx(String(i).repeat(64), ["MERGE"]));
  expect(closingHashes(record({ transactions: six.slice(0, 5) }))?.length).toBe(5);
  expect(closingHashes(record({ transactions: six }))).toBe(null);
  expect(closingHashes(record({ outcome: "incomplete" }))).toBe(null);
  expect(closingHashes(record({ transactions: [tx(C, ["CANCEL_OFFERS"])] }))).toBe(null);
  expect(closingHashes(record({ transactions: [tx("a/../b", ["MERGE"])] }))).toBe(null);
  expect(closingHashes(record({ transactions: [tx(A, ["MERGE"]), tx("x", ["MERGE"])] }))).toBe(
    null
  );
});

test("an answer with every asked hash delivered reads as its total", () => {
  expect(readReceived(answer, asked)).toBe("12.3400000");
});

test("the destination is compared without regard to case, and any other is refused", () => {
  expect(readReceived({ ...answer, destination: DEST.toLowerCase() }, asked)).toBe("12.3400000");
  const other = "GOTHER00000000000000000000000000000000000000000000000000";
  expect(readReceived({ ...answer, destination: other }, asked)).toBe(null);
  expect(readReceived({ ...answer, destination: undefined }, asked)).toBe(null);
});

test("an answer that does not establish the amount is never read as one", () => {
  const cases: unknown[] = [
    null,
    "12",
    { ...answer, totalStroops: undefined },
    { ...answer, totalStroops: "123400001" },
    { ...answer, totalStroops: "1.5" },
    { ...answer, totalStroops: 123400000 },
    { ...answer, entries: [answer.entries[0]] },
    { ...answer, entries: [answer.entries[1], answer.entries[0]] },
    { ...answer, entries: [answer.entries[0], delivered(C, "23400000")] },
    {
      ...answer,
      entries: [answer.entries[0], { hash: B, status: "unavailable", reason: "not_found" }],
      totalStroops: "100000000",
    },
    { ...answer, entries: [answer.entries[0], delivered(B, "-1")], totalStroops: "99999999" },
    { ...answer, entries: [answer.entries[0], { ...answer.entries[1], amountStroops: 23400000 }] },
    { ...answer, entries: "all" },
    // Fewer or more entries than asked, even with a total that matches them.
    { ...answer, entries: [answer.entries[0]], totalStroops: "100000000" },
    {
      ...answer,
      entries: [...answer.entries, delivered(C, "1")],
      totalStroops: "123400001",
    },
    // An entry not delivered never counts, whatever amount it carries.
    {
      ...answer,
      entries: [answer.entries[0], { ...answer.entries[1], status: "unavailable" }],
    },
  ];
  for (const response of cases) expect(readReceived(response, asked)).toBe(null);
});

test("an entry's hash is compared without regard to case", () => {
  const upper = {
    ...answer,
    entries: [delivered(A.toUpperCase(), "100000000"), answer.entries[1]],
  };
  expect(readReceived(upper, asked)).toBe("12.3400000");
});

test("stroops convert to XLM exactly, with all seven decimals", () => {
  expect(stroopsToFixedLumens("0")).toBe("0.0000000");
  expect(stroopsToFixedLumens("1")).toBe("0.0000001");
  expect(stroopsToFixedLumens("123400000")).toBe("12.3400000");
  expect(stroopsToFixedLumens("9223372036854775807")).toBe("922337203685.4775807");
});

test("an amount is shown exactly, grouped, with two to seven decimals", () => {
  expect(formatLumensExact("12.3400000")).toBe("12.34");
  expect(formatLumensExact("5")).toBe("5.00");
  expect(formatLumensExact("0.0000001")).toBe("0.0000001");
  expect(formatLumensExact("1234.5")).toBe("1,234.50");
  // Past what a float holds: every digit is kept.
  expect(formatLumensExact("922337203685.4775807")).toBe("922,337,203,685.4775807");
  expect(formatLumensExact("12345678901234567.1")).toBe("12,345,678,901,234,567.10");
});

test("a value that is not a plain amount is not shown as one", () => {
  for (const value of ["", "-1", "1.12345678", "1e5", "abc", "1,000", " 1", ".5", "1."]) {
    expect(formatLumensExact(value)).toBe(null);
  }
});
