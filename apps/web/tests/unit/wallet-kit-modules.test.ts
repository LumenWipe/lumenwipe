import { test, expect, spyOn } from "bun:test";
import { LOBSTR_ID } from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import {
  ALLOWED_DEFAULT_MODULE_IDS,
  vettedDefaultModules,
  walletConnectConfigured,
  walletConnectMetadata,
  walletKitModules,
} from "@/lib/wallet-kit/modules";

test("vettedDefaultModules › never includes LOBSTR's own module", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  expect(ids).not.toContain(LOBSTR_ID);
});

test("vettedDefaultModules › includes exactly the vetted whitelist, nothing else", () => {
  const ids = vettedDefaultModules()
    .map((m) => m.productId)
    .sort();
  expect(ids).toEqual([...ALLOWED_DEFAULT_MODULE_IDS].sort());
});

test("vettedDefaultModules › includes Freighter", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  expect(ids).toContain(FREIGHTER_ID);
});

test("walletConnectMetadata › falls back to the site's real www domain, not the bare apex", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  try {
    const metadata = walletConnectMetadata();
    expect(metadata.url).toBe("https://www.lumenwipe.com");
    expect(metadata.icons).toEqual(["https://www.lumenwipe.com/favicon-96x96.png"]);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  }
});

test("walletConnectMetadata › respects NEXT_PUBLIC_APP_URL when it's set", () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  process.env.NEXT_PUBLIC_APP_URL = "https://staging.lumenwipe.com";
  try {
    const metadata = walletConnectMetadata();
    expect(metadata.url).toBe("https://staging.lumenwipe.com");
    expect(metadata.icons).toEqual(["https://staging.lumenwipe.com/favicon-96x96.png"]);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  }
});

function withProjectId<T>(id: string | undefined, fn: () => T): T {
  const saved = process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  if (id === undefined) delete process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  else process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID = id;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
    else process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID = saved;
  }
}

test("walletConnectConfigured › reads the project id, ignoring an empty or blank value", () => {
  expect(withProjectId(undefined, walletConnectConfigured)).toBe(false);
  expect(withProjectId("  ", walletConnectConfigured)).toBe(false);
  expect(withProjectId("0".repeat(32), walletConnectConfigured)).toBe(true);
});

test("walletKitModules › without a project id: the vetted wallets only, and nothing logged", () => {
  const warn = spyOn(console, "warn");
  try {
    const ids = withProjectId(undefined, walletKitModules).map((m) => m.productId);
    expect(ids.sort()).toEqual([...ALLOWED_DEFAULT_MODULE_IDS].sort());
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});
