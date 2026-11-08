import { describe, expect, test } from "bun:test";
import type { NextFunction, Request, Response } from "express";
import {
  DEPRECATION_HEADER_VALUE,
  LEGACY_ALIAS_DEPRECATED_AT,
  LEGACY_ALIAS_SUNSET_AT,
  SUNSET_HEADER_VALUE,
  legacyAliasLinkHeader,
  legacyAliasMiddleware,
  legacyAliasTarget,
} from "@/common/legacy-aliases";

describe("legacyAliasTarget", () => {
  test.each([
    ["/testnet/account/GABC", "/v1/testnet/account/GABC"],
    ["/mainnet/allowances/GABC", "/v1/mainnet/allowances/GABC"],
    ["/testnet/allowances/revoke", "/v1/testnet/allowances/revoke"],
    ["/testnet/paths", "/v1/testnet/paths"],
    ["/testnet/mediator/sign", "/v1/testnet/mediator/sign"],
    ["/testnet/mediator/check/GABC", "/v1/testnet/mediator/check/GABC"],
    ["/testnet/fee-bump/sponsor", "/v1/testnet/fee-bump/sponsor"],
    ["/config/exchange-registry", "/v1/config/exchange-registry"],
    ["/integrator/auth/challenge", "/v1/integrator/auth/challenge"],
    ["/integrator/keys/abc/rotate", "/v1/integrator/keys/abc/rotate"],
    ["/integrator", "/v1/integrator"],
    ["/badnet/account/G", "/v1/badnet/account/G"],
    ["/TestNet/Account/G", "/v1/TestNet/Account/G"],
    ["/testnet/paths/", "/v1/testnet/paths/"],
  ])("%s is served by %s", (legacy, canonical) => {
    expect(legacyAliasTarget(legacy)).toBe(canonical);
  });

  test.each([
    "/",
    "/health",
    "/health/deep",
    "/docs",
    "/docs/account/x",
    "/docs-json",
    "/admin/api-keys",
    "/admin/paths",
    "/ADMIN/account/x",
    "/v1/testnet/account/G",
    "/v1/config/exchange-registry",
    "/v1/integrator/keys",
    "/v1/paths",
    "/testnet/close/plan",
    "/testnet/submit",
    "/testnet/stats",
    "/configs",
    "/integrators/keys",
    "/testnet/accounts/G",
    "/testnet/pathsx",
    "/a/b/account/G",
  ])("%s is not an alias", (path) => {
    expect(legacyAliasTarget(path)).toBeNull();
  });
});

describe("header values", () => {
  test("Sunset is 2027-06-01 as an HTTP-date, and Deprecation the RFC 9745 date before it", () => {
    expect(SUNSET_HEADER_VALUE).toBe("Tue, 01 Jun 2027 00:00:00 GMT");
    expect(DEPRECATION_HEADER_VALUE).toBe("@1794182400");
    expect(LEGACY_ALIAS_DEPRECATED_AT.getTime()).toBeLessThan(LEGACY_ALIAS_SUNSET_AT.getTime());
  });

  test("the Link names the successor and the policy", () => {
    expect(legacyAliasLinkHeader("/v1/testnet/account/GABC")).toBe(
      '</v1/testnet/account/GABC>; rel="successor-version", ' +
        '<https://docs.lumenwipe.com/api-reference/introduction#versioning>; rel="deprecation"'
    );
  });

  test("a successor path cannot close the reference or add a link", () => {
    const header = legacyAliasLinkHeader('/v1/testnet/account/x>; rel="evil", <https://e.example');
    expect(
      header.startsWith("</v1/testnet/account/x%3E;%20rel=%22evil%22,%20%3Chttps://e.example>;")
    ).toBe(true);
    expect(header.match(/</g)).toHaveLength(2);
    expect(header.match(/>/g)).toHaveLength(2);
  });
});

function run(url: string): {
  req: { url: string };
  headers: Map<string, string>;
  locals: Record<string, unknown>;
} {
  const req = { url };
  const headers = new Map<string, string>();
  const locals: Record<string, unknown> = {};
  const res = { setHeader: (name: string, value: string) => headers.set(name, value), locals };
  let called = 0;
  legacyAliasMiddleware()(
    req as unknown as Request,
    res as unknown as Response,
    (() => called++) as NextFunction
  );
  expect(called).toBe(1);
  return { req, headers, locals };
}

describe("legacyAliasMiddleware", () => {
  test("rewrites the path, keeps the query, and sets the headers", () => {
    const { req, headers, locals } = run("/testnet/paths?fromAsset=USDC:G&amount=1");
    expect(req.url).toBe("/v1/testnet/paths?fromAsset=USDC:G&amount=1");
    expect(headers.get("Deprecation")).toBe("@1794182400");
    expect(headers.get("Sunset")).toBe("Tue, 01 Jun 2027 00:00:00 GMT");
    expect(headers.get("Link")).toStartWith('</v1/testnet/paths>; rel="successor-version"');
    expect(locals.deprecatedAlias).toBe(true);
  });

  test("leaves a /v1 or operational request untouched", () => {
    for (const url of ["/v1/testnet/paths?amount=1", "/health", "/admin/api-keys?x=1"]) {
      const { req, headers, locals } = run(url);
      expect(req.url).toBe(url);
      expect(headers.size).toBe(0);
      expect(locals.deprecatedAlias).toBeUndefined();
    }
  });
});
