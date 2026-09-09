import { afterAll, beforeAll, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { AppModule } from "@/app.module";
import { configureApp } from "@/configure-app";
import { buildOpenApiConfig } from "@/openapi";

let app: INestApplication;
let spec: OpenAPIObject;

beforeAll(async () => {
  process.env.API_KEYS = "test=e2e_test_key";
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ bodyParser: false });
  configureApp(app);
  await app.init();
  spec = SwaggerModule.createDocument(app, buildOpenApiConfig());
});

afterAll(async () => {
  await app.close();
});

test("spec declares the Bearer API-key security scheme", () => {
  expect(spec.components?.securitySchemes?.["api-key"]).toMatchObject({
    type: "http",
    scheme: "bearer",
    bearerFormat: "opaque", // not "JWT" - the credential is an opaque API key
  });
});

test("spec documents all v1 + read + mediator endpoints", () => {
  const paths = Object.keys(spec.paths);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/",
      "/health",
      "/v1/{network}/close/plan",
      "/v1/{network}/close/transactions",
      "/v1/{network}/submit",
      "/{network}/account/{address}",
      "/{network}/paths",
      "/{network}/mediator/sign",
      "/{network}/mediator/check/{address}",
    ])
  );
});

test("request DTOs are present as schemas", () => {
  const schemas = Object.keys(spec.components?.schemas ?? {});
  expect(schemas).toEqual(
    expect.arrayContaining([
      "ClosePlanRequestDto",
      "CloseTransactionsRequestDto",
      "SubmitRequestDto",
      "MediatorSignRequestDto",
    ])
  );
});

test("response DTOs are present as schemas and wired to their 200 responses (#59)", () => {
  const schemas = Object.keys(spec.components?.schemas ?? {});
  expect(schemas).toEqual(
    expect.arrayContaining([
      "SubmitResponseDto",
      "RevokeAllowanceResponseDto",
      "PathResponseDto",
      "ConversionPathDto",
      "MediatorSignResponseDto",
      "MediatorCheckResultDto",
      "FeeBumpSponsorResponseDto",
      "ServedRegistryDto",
      "RegistryEntryDto",
    ])
  );

  const refOf = (schema: unknown): string | undefined =>
    (schema as { $ref?: string; allOf?: { $ref?: string }[] })?.$ref ??
    (schema as { allOf?: { $ref?: string }[] })?.allOf?.[0]?.$ref;

  const submit = spec.paths["/v1/{network}/submit"].post?.responses?.["200"];
  expect(
    refOf(
      (submit as { content?: Record<string, { schema: unknown }> })?.content?.["application/json"]
        ?.schema
    )
  ).toBe("#/components/schemas/SubmitResponseDto");

  const mediatorCheck = spec.paths["/{network}/mediator/check/{address}"].get?.responses?.["200"];
  expect(
    refOf(
      (mediatorCheck as { content?: Record<string, { schema: unknown }> })?.content?.[
        "application/json"
      ]?.schema
    )
  ).toBe("#/components/schemas/MediatorCheckResultDto");
});

test("phase 2 response schemas (allowances, close/plan) are present and wired (#59)", () => {
  const schemas = Object.keys(spec.components?.schemas ?? {});
  expect(schemas).toEqual(
    expect.arrayContaining([
      "AllowancesResultDto",
      "AllowanceDto",
      "AllowanceCoverageDto",
      "PlanResponseDto",
      "PlannedStepDto",
      "DecisionPointDto",
      "DecisionOptionDto",
      "PlanBlockerDto",
      "PlanResponseBlockerDto",
    ])
  );

  const refOf = (schema: unknown): string | undefined =>
    (schema as { $ref?: string; allOf?: { $ref?: string }[] })?.$ref ??
    (schema as { allOf?: { $ref?: string }[] })?.allOf?.[0]?.$ref;

  const allowances = spec.paths["/{network}/allowances/{address}"].get?.responses?.["200"];
  expect(
    refOf(
      (allowances as { content?: Record<string, { schema: unknown }> })?.content?.[
        "application/json"
      ]?.schema
    )
  ).toBe("#/components/schemas/AllowancesResultDto");

  const plan = spec.paths["/v1/{network}/close/plan"].post?.responses?.["200"];
  expect(
    refOf(
      (plan as { content?: Record<string, { schema: unknown }> })?.content?.["application/json"]
        ?.schema
    )
  ).toBe("#/components/schemas/PlanResponseDto");
});

test("account response schema, including its discriminated unions, is present and wired (#59)", () => {
  const schemas = spec.components?.schemas ?? {};
  const schemaNames = Object.keys(schemas);
  expect(schemaNames).toEqual(
    expect.arrayContaining([
      "AccountStateDto",
      "BlendSupplyPositionDto",
      "BlendBorrowPositionDto",
      "AquariusLpPositionDto",
      "SoroswapLpPositionDto",
      "PhoenixLpPositionDto",
      "PhoenixStakePositionDto",
      "FxdaoCdpPositionDto",
      "SponsoredAccountDto",
      "SponsoredTrustlineDto",
      "SponsoredOfferDto",
      "SponsoredDataEntryDto",
      "SponsoredSignerDto",
      "SponsoredClaimableBalanceDto",
      "ClaimPredicateDto",
    ])
  );

  const refOf = (schema: unknown): string | undefined =>
    (schema as { $ref?: string; allOf?: { $ref?: string }[] })?.$ref ??
    (schema as { allOf?: { $ref?: string }[] })?.allOf?.[0]?.$ref;

  const account = spec.paths["/{network}/account/{address}"].get?.responses?.["200"];
  expect(
    refOf(
      (account as { content?: Record<string, { schema: unknown }> })?.content?.["application/json"]
        ?.schema
    )
  ).toBe("#/components/schemas/AccountStateDto");

  // The DefiPosition union has no single-field discriminator (protocol alone collides for
  // Blend's two variants and Phoenix's two) - it's a plain oneOf, not a discriminated one.
  const positions = (schemas["DefiPositionsResultDto"] as { properties?: Record<string, unknown> })
    ?.properties?.["positions"] as { items?: { oneOf?: { $ref: string }[] } };
  expect(positions?.items?.oneOf?.length).toBe(7);

  // sponsoredEntries DOES have a clean single-field discriminator (`kind`) - assert the mapping
  // actually names real values, not the "every model reads back undefined" bug this once had.
  const sponsoredEntries = (schemas["AccountStateDto"] as { properties?: Record<string, unknown> })
    ?.properties?.["sponsoredEntries"] as {
    items?: { discriminator?: { mapping?: Record<string, string> } };
  };
  expect(Object.keys(sponsoredEntries?.items?.discriminator?.mapping ?? {})).toEqual(
    expect.arrayContaining([
      "account",
      "trustline",
      "offer",
      "data_entry",
      "signer",
      "claimable_balance",
    ])
  );
});

test("close/transactions response schema, including the 11-variant operation union, is present and wired (#59)", () => {
  const schemas = spec.components?.schemas ?? {};
  const schemaNames = Object.keys(schemas);
  expect(schemaNames).toEqual(
    expect.arrayContaining([
      "TransactionsResponseDto",
      "CloseTransactionDto",
      "TxIntentDto",
      "PathPaymentStrictSendOpDto",
      "PaymentOpDto",
      "ChangeTrustOpDto",
      "AccountMergeOpDto",
      "ManageSellOfferOpDto",
      "ManageDataOpDto",
      "SetOptionsOpDto",
      "ClaimClaimableBalanceOpDto",
      "RevokeSponsorshipOpDto",
      "InvokeHostFunctionOpDto",
      "UnknownOpDto",
      "SubInvocationCallDto",
    ])
  );

  const refOf = (schema: unknown): string | undefined =>
    (schema as { $ref?: string; allOf?: { $ref?: string }[] })?.$ref ??
    (schema as { allOf?: { $ref?: string }[] })?.allOf?.[0]?.$ref;

  const transactions = spec.paths["/v1/{network}/close/transactions"].post?.responses?.["200"];
  expect(
    refOf(
      (transactions as { content?: Record<string, { schema: unknown }> })?.content?.[
        "application/json"
      ]?.schema
    )
  ).toBe("#/components/schemas/TransactionsResponseDto");

  // A clean single-field discriminator (`type`) - all 11 operation shapes must be mapped, by
  // their real literal type values, not the "undefined" bug the SponsoredEntry union
  // (account-state-response.dto.ts) once had.
  const operations = (schemas["TxIntentDto"] as { properties?: Record<string, unknown> })
    ?.properties?.["operations"] as {
    items?: { oneOf?: unknown[]; discriminator?: { mapping?: Record<string, string> } };
  };
  expect(operations?.items?.oneOf?.length).toBe(11);
  expect(Object.keys(operations?.items?.discriminator?.mapping ?? {})).toEqual(
    expect.arrayContaining([
      "path_payment_strict_send",
      "payment",
      "change_trust",
      "account_merge",
      "manage_sell_offer",
      "manage_data",
      "set_options",
      "claim_claimable_balance",
      "revoke_sponsorship",
      "invoke_host_function",
      "unknown",
    ])
  );
});

test("health and the service index are public but the product endpoints require the api-key", () => {
  const health = spec.paths["/health"].get;
  const index = spec.paths["/"].get;
  const plan = spec.paths["/v1/{network}/close/plan"].post;
  // neither public route carries a security requirement; close/plan requires api-key
  expect(health?.security ?? []).toEqual([]);
  expect(index?.security ?? []).toEqual([]);
  expect(plan?.security).toEqual(expect.arrayContaining([{ "api-key": [] }]));
});
