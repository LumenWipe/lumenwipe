import { expect, test } from "bun:test";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { appUrlBuildError } from "@/config/app-url-build.mjs";
import config from "@/next.config.mjs";

const VARIABLE = "NEXT_PUBLIC_APP_URL";
const WALLET_CONNECT = {
  NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID: "0123456789abcdef0123456789abcdef",
};

test("app-url-build › a production deployment without the site origin is refused, by name", () => {
  const error = appUrlBuildError({ VERCEL_ENV: "production" });
  expect(error).toContain(`${VARIABLE} is not set`);
  expect(appUrlBuildError({ VERCEL_ENV: "production", [VARIABLE]: "  " })).toBe(error);
});

test("app-url-build › a production origin that is not a bare https origin is refused", () => {
  for (const value of [
    "lumenwipe.com",
    "http://lumenwipe.com",
    "https://lumenwipe.com/app",
    "https://lumenwipe.com/?ref=x",
    "https://lumenwipe.com/#top",
    "https://user:pass@lumenwipe.com",
  ]) {
    expect(appUrlBuildError({ VERCEL_ENV: "production", [VARIABLE]: value })).toContain(
      "must be an https origin with no path"
    );
  }
});

test("app-url-build › the apex and www origins are accepted as they are, with or without a slash", () => {
  for (const value of [
    "https://lumenwipe.com",
    "https://www.lumenwipe.com/",
    " https://lumenwipe.com ",
  ]) {
    expect(appUrlBuildError({ VERCEL_ENV: "production", [VARIABLE]: value })).toBeNull();
  }
});

test("app-url-build › preview, CI and local builds are not held to it", () => {
  for (const VERCEL_ENV of [undefined, "preview", "development"]) {
    expect(appUrlBuildError({ VERCEL_ENV })).toBeNull();
  }
});

test("next.config › a production build without the site origin throws its message", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { VERCEL_ENV: "production", ...WALLET_CONNECT });
    delete process.env[VARIABLE];
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(`${VARIABLE} is not set`);
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
    process.env[VARIABLE] = "https://lumenwipe.com";
    expect(() => config(PHASE_PRODUCTION_BUILD)).not.toThrow();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
