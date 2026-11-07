import { expect, test } from "bun:test";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { walletConnectBuildError } from "@/config/wallet-connect-build.mjs";
import config from "@/next.config.mjs";

// Synthetic ids only: a real project id is never committed.
const SYNTHETIC_ID = "0123456789abcdef0123456789abcdef";
const PLACEHOLDER = "0".repeat(32);
const VARIABLE = "NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID";

test("wallet-connect-build › a production deployment without the project id is refused, by name", () => {
  const error = walletConnectBuildError({ VERCEL_ENV: "production" });
  expect(error).toContain(`${VARIABLE} is not set`);
  expect(walletConnectBuildError({ VERCEL_ENV: "production", [VARIABLE]: "  " })).toBe(error);
});

test("wallet-connect-build › a production deployment with a malformed id or the placeholder is refused", () => {
  for (const id of ["not-an-id", SYNTHETIC_ID.slice(1), `${SYNTHETIC_ID}0`, PLACEHOLDER]) {
    expect(walletConnectBuildError({ VERCEL_ENV: "production", [VARIABLE]: id })).toContain(
      "is not a WalletConnect project id"
    );
  }
});

test("wallet-connect-build › a production deployment with a project id builds", () => {
  expect(
    walletConnectBuildError({ VERCEL_ENV: "production", [VARIABLE]: SYNTHETIC_ID })
  ).toBeNull();
  expect(
    walletConnectBuildError({
      VERCEL_ENV: "production",
      [VARIABLE]: ` ${SYNTHETIC_ID.toUpperCase()}\n`,
    })
  ).toBeNull();
});

test("wallet-connect-build › previews, CI and local builds build without it", () => {
  for (const VERCEL_ENV of [undefined, "preview", "development"]) {
    expect(walletConnectBuildError({ VERCEL_ENV })).toBeNull();
    expect(walletConnectBuildError({ VERCEL_ENV, [VARIABLE]: PLACEHOLDER })).toBeNull();
  }
});

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("wallet-connect-build › the Next config fails only the production build of a production deployment", () => {
  withEnv({ VERCEL_ENV: "production", [VARIABLE]: undefined }, () => {
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow(`${VARIABLE} is not set`);
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
  });
  withEnv({ VERCEL_ENV: "preview", [VARIABLE]: undefined }, () => {
    expect(config(PHASE_PRODUCTION_BUILD).reactStrictMode).toBe(true);
  });
});
