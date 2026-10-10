import { describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { Keypair } from "@stellar/stellar-sdk";
import { MAX_DECISIONS, parseDecisions } from "@/lib/close-api/parse-decisions";
import { computePlanHash } from "@/lib/close-api/plan-response";

const rejection = (value: unknown): { status: number; code: string } => {
  try {
    parseDecisions(value);
  } catch (e) {
    if (e instanceof HttpException) {
      const body = e.getResponse() as { error: { code: string } };
      return { status: e.getStatus(), code: body.error.code };
    }
    throw e;
  }
  throw new Error("expected parseDecisions to reject");
};

const BAD_REQUEST = { status: 400, code: "invalid_decisions" };
const valid = { id: "asset:USDC-G", choice: "convert_to_xlm" };

describe("parseDecisions accepts", () => {
  test("an absent value as no answers", () => {
    expect(parseDecisions(undefined)).toEqual([]);
  });

  test("an empty array", () => {
    expect(parseDecisions([])).toEqual([]);
  });

  test("a fully parameterised answer, unchanged and by reference", () => {
    const answers: unknown[] = [
      {
        id: `asset:USDC-${Keypair.random().publicKey()}`,
        choice: "transfer_to_account",
        params: {
          maxSlippageBps: 100,
          minAmountOut: "123456789012",
          provider: "soroswap",
          destination: Keypair.random().publicKey(),
          futureField: true,
        },
      },
      { id: "destination:G", choice: "i_control_this_address" },
    ];
    const parsed = parseDecisions(answers);
    expect(parsed as unknown).toBe(answers);
    expect(parsed[0] as unknown).toBe(answers[0]);
  });

  test("an unrecognised provider name, left for the typed 422 downstream", () => {
    expect(parseDecisions([{ ...valid, params: { provider: "nope" } }])).toHaveLength(1);
  });

  test("a muxed-length destination and the maximum number of answers", () => {
    const muxed = "M".padEnd(69, "A");
    expect(parseDecisions([{ ...valid, params: { destination: muxed } }])).toHaveLength(1);
    expect(parseDecisions(Array.from({ length: MAX_DECISIONS }, () => valid))).toHaveLength(
      MAX_DECISIONS
    );
  });

  test("yields the same plan hash as the raw input", () => {
    const raw = [
      { id: "b", choice: "x", params: { maxSlippageBps: 50, minAmountOut: "1", extra: 1 } },
      { id: "a", choice: "y" },
    ];
    const hashOf = (decisions: unknown[]): string =>
      computePlanHash({
        source: "S",
        destination: "D",
        decisions: decisions as Parameters<typeof computePlanHash>[0]["decisions"],
        snapshotLedger: 7,
      });
    expect(hashOf(parseDecisions(raw))).toBe(hashOf(raw));
  });
});

describe("parseDecisions rejects with 400 invalid_decisions", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["a string", "x"],
    ["an object", { id: "a", choice: "b" }],
    ["a null element", [null]],
    ["a primitive element", [42]],
    ["an array element", [[]]],
    ["an empty object", [{}]],
    ["a numeric id", [{ id: 1, choice: "x" }]],
    ["an empty id", [{ id: "", choice: "x" }]],
    ["a missing choice", [{ id: "a" }]],
    ["a numeric choice", [{ id: "a", choice: 2 }]],
    ["array params", [{ ...valid, params: [] }]],
    ["null params", [{ ...valid, params: null }]],
    ["a string maxSlippageBps", [{ ...valid, params: { maxSlippageBps: "100" } }]],
    ["a non-finite maxSlippageBps", [{ ...valid, params: { maxSlippageBps: Infinity } }]],
    ["a numeric minAmountOut", [{ ...valid, params: { minAmountOut: 5 } }]],
    ["a numeric destination", [{ ...valid, params: { destination: 5 } }]],
    ["an oversize destination", [{ ...valid, params: { destination: "G".repeat(70) } }]],
    ["an oversize minAmountOut", [{ ...valid, params: { minAmountOut: "1".repeat(41) } }]],
    ["an oversize id", [{ id: "a".repeat(201), choice: "x" }]],
    ["an oversize choice", [{ id: "a", choice: "c".repeat(65) }]],
    ["an oversize array", Array.from({ length: MAX_DECISIONS + 1 }, () => valid)],
  ];
  for (const [name, value] of cases) {
    test(name, () => {
      expect(rejection(value)).toEqual(BAD_REQUEST);
    });
  }
});
