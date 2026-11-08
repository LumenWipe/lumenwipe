import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MAX_SESSION_SECONDS,
  SESSION_COOKIE,
  clearSessionCookie,
  cookieMaxAge,
  parseSessionToken,
  sessionFromRequest,
  setSessionCookie,
} from "@/lib/integrator/session-cookie";

const ADDRESS = Keypair.random().publicKey();
const NOW = new Date("2026-01-01T00:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const token = (address = ADDRESS, exp = NOW_S + 1800) => `lws.${address}.${exp}.bWFjLXZhbHVl`;

describe("parseSessionToken", () => {
  test("reads the address and expiry of a well-formed token", () => {
    expect(parseSessionToken(token())).toEqual({
      token: token(),
      address: ADDRESS,
      exp: NOW_S + 1800,
    });
  });

  test.each([
    ["no prefix", `xyz.${ADDRESS}.${NOW_S}.mac`],
    ["no mac", `lws.${ADDRESS}.${NOW_S}.`],
    ["an extra part", `${token()}.more`],
    ["a non-integer expiry", `lws.${ADDRESS}.1.5.mac`],
    ["a bad checksum", `lws.${ADDRESS.slice(0, -1)}A.${NOW_S}.mac`],
    ["a contract address", `lws.CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA.1.mac`],
    ["a space in the mac", `lws.${ADDRESS}.${NOW_S}.ma c`],
  ])("refuses a token with %s", (_, value) => {
    expect(parseSessionToken(value)).toBeNull();
  });

  test("refuses anything but a string", () => {
    expect(parseSessionToken(undefined)).toBeNull();
    expect(parseSessionToken({ token: token() })).toBeNull();
  });
});

describe("cookieMaxAge", () => {
  test("is what is left of the token, capped at the API's lifetime and floored at zero", () => {
    expect(cookieMaxAge(NOW_S + 600, NOW)).toBe(600);
    expect(cookieMaxAge(NOW_S + 86_400, NOW)).toBe(MAX_SESSION_SECONDS);
    expect(cookieMaxAge(NOW_S - 5, NOW)).toBe(0);
  });
});

describe("the session cookie", () => {
  test("is httpOnly, Secure, SameSite=Strict, scoped to the integrator routes, with no Domain", () => {
    const res = NextResponse.json({});
    setSessionCookie(res, parseSessionToken(token())!, NOW);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toContain("Path=/api/integrator");
    expect(header).toContain("Max-Age=1800");
    expect(header).not.toMatch(/Domain=/i);
  });

  test("clearing it keeps the same attributes and expires it", () => {
    const res = NextResponse.json({});
    clearSessionCookie(res);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/api/integrator");
  });

  test("is read back only while unexpired", () => {
    const req = (value: string) => {
      // The DOM test environment's Request drops a `cookie` header passed to the constructor.
      const r = new NextRequest("https://www.lumenwipe.com/api/integrator/keys");
      r.cookies.set(SESSION_COOKIE, value);
      return r;
    };
    expect(sessionFromRequest(req(token()), NOW)?.address).toBe(ADDRESS);
    expect(sessionFromRequest(req(token(ADDRESS, NOW_S)), NOW)).toBeNull();
    expect(sessionFromRequest(req("garbage"), NOW)).toBeNull();
    expect(
      sessionFromRequest(new NextRequest("https://www.lumenwipe.com/api/integrator/keys"), NOW)
    ).toBeNull();
  });
});
