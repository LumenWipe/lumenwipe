import { describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import { FILTER_CATCH_EXCEPTIONS } from "@nestjs/common/constants";
import type { ArgumentsHost } from "@nestjs/common";
import { PlanErrorFilter, TransactionErrorFilter } from "@/close/domain-error.filters";
import { CloseBuildError } from "@/lib/close-api/build-transactions";
import {
  decisionIdFor,
  MissingConversionFloorError,
  MissingTransferDestinationError,
  tokenDecisionId,
  UnrecognizedConversionProviderError,
} from "@/lib/close-api/decisions";
import { mapDomainError, PLAN_ERRORS, TRANSACTION_ERRORS } from "@/lib/close-api/domain-errors";
import { planBatch } from "@/lib/close-api/batch-plan";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import {
  AccountNotFoundError,
  AssetRouteLostError,
  UnusableProviderResponseError,
} from "@/lib/utils/errors";

const ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const CONTRACT = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

function respondWith(filter: PlanErrorFilter | TransactionErrorFilter, error: unknown) {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  filter.catch(error, host);
  return sent;
}

type Case = [string, Error, number, string, unknown];

const PLAN_CASES: Case[] = [
  ["account not found", new AccountNotFoundError(ADDRESS), 404, "account_not_found", undefined],
  [
    "truncated collection",
    new TruncatedCollectionError("too many offers"),
    422,
    "account_too_large",
    undefined,
  ],
  [
    "unusable provider",
    new UnusableProviderResponseError(ADDRESS, ["offers"]),
    502,
    "provider_response_unusable",
    undefined,
  ],
];

const TRANSACTION_CASES: Case[] = [
  ["account not found", new AccountNotFoundError(ADDRESS), 404, "account_not_found", undefined],
  [
    "asset route lost",
    new AssetRouteLostError(`USDC:${ADDRESS}`, "USDC"),
    409,
    "quote_drifted",
    undefined,
  ],
  [
    "missing transfer destination",
    new MissingTransferDestinationError(`USDC:${ADDRESS}`),
    422,
    "transfer_destination_missing",
    { decisionId: decisionIdFor(`USDC:${ADDRESS}`) },
  ],
  [
    "missing conversion floor",
    new MissingConversionFloorError(CONTRACT),
    422,
    "conversion_floor_missing",
    { decisionId: tokenDecisionId(CONTRACT) },
  ],
  [
    "unrecognized provider",
    new UnrecognizedConversionProviderError(CONTRACT, "xbulll"),
    422,
    "conversion_provider_unrecognized",
    { decisionId: tokenDecisionId(CONTRACT) },
  ],
];

describe("PlanErrorFilter", () => {
  test.each(PLAN_CASES)("%s", (_name, error, status, code) => {
    expect(respondWith(new PlanErrorFilter(), error)).toEqual({
      status,
      body: { error: { code, message: error.message } },
    });
  });
});

describe("TransactionErrorFilter", () => {
  test.each(TRANSACTION_CASES)("%s", (_name, error, status, code, details) => {
    const expected: Record<string, unknown> = { code, message: expectedMessage(error) };
    if (details !== undefined) expected.details = details;
    expect(respondWith(new TransactionErrorFilter(), error)).toEqual({
      status,
      body: { error: expected },
    });
  });
});

function expectedMessage(error: Error): string {
  return error instanceof AssetRouteLostError
    ? "A conversion route is no longer available; re-plan and retry."
    : error.message;
}

describe("what each filter catches", () => {
  const caught = (filter: object): unknown[] =>
    Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, filter.constructor) as unknown[];

  test("the plan filter catches exactly the planning errors", () => {
    expect(caught(new PlanErrorFilter())).toEqual(PLAN_CASES.map(([, e]) => e.constructor));
  });

  test("the transactions filter catches exactly the build-time domain errors", () => {
    expect(new Set(caught(new TransactionErrorFilter()))).toEqual(
      new Set(TRANSACTION_CASES.map(([, e]) => e.constructor))
    );
  });

  test("neither mapping claims an HttpException or a CloseBuildError", () => {
    const passThrough = [
      new HttpException({ error: { code: "invalid_body" } }, 400),
      new CloseBuildError("memo_required", "memo", 422),
      new Error("boom"),
    ];
    for (const error of passThrough) {
      expect(mapDomainError(PLAN_ERRORS, error)).toBeNull();
      expect(mapDomainError(TRANSACTION_ERRORS, error)).toBeNull();
    }
  });

  test("plan-only errors stay out of the transactions mapping and the reverse", () => {
    expect(mapDomainError(TRANSACTION_ERRORS, new TruncatedCollectionError("x"))).toBeNull();
    expect(
      mapDomainError(TRANSACTION_ERRORS, new UnusableProviderResponseError(ADDRESS, ["x"]))
    ).toBeNull();
    expect(mapDomainError(PLAN_ERRORS, new AssetRouteLostError("a", "A"))).toBeNull();
  });
});

describe("close/plan and close/batch-plan share one mapping", () => {
  test.each(PLAN_CASES)("%s is the same blocker code", async (_name, error, _status, code) => {
    const [{ plan }] = await planBatch([ADDRESS], null, "testnet", {
      buildAccountPlan: () => Promise.reject(error),
    });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual([{ code, message: error.message }]);
  });

  test("an unrecognized error falls back to plan_failed", async () => {
    const [{ plan }] = await planBatch([ADDRESS], null, "testnet", {
      buildAccountPlan: () => Promise.reject(new Error("boom")),
    });
    expect(plan.blockers).toEqual([
      { code: "plan_failed", message: `Failed to build the close plan for ${ADDRESS}.` },
    ]);
  });
});
