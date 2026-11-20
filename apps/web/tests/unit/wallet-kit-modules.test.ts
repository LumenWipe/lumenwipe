import { test, expect, spyOn } from "bun:test";
import { LOBSTR_ID } from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { FREIGHTER_ID } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import * as varial from "@creit-tech/stellar-wallets-kit/modules/varial";
import * as xbull from "@creit-tech/stellar-wallets-kit/modules/xbull";
import * as albedo from "@creit-tech/stellar-wallets-kit/modules/albedo";
import * as rabet from "@creit-tech/stellar-wallets-kit/modules/rabet";
import * as hana from "@creit-tech/stellar-wallets-kit/modules/hana";
import * as walletConnect from "@creit-tech/stellar-wallets-kit/modules/wallet-connect";
import * as ledger from "@creit-tech/stellar-wallets-kit/modules/ledger";
import { TREZOR_ID } from "@creit-tech/stellar-wallets-kit/modules/trezor";
import { WALLET_CONNECT_WALLET_ID } from "@/lib/stellar/signer";
import {
  ALLOWED_DEFAULT_MODULE_IDS,
  vettedDefaultModules,
  walletKitModules,
} from "@/lib/wallet-kit/modules";
import {
  walletConnectConfigured,
  walletConnectMetadata,
} from "@/lib/wallet-kit/wallet-connect-config";
import * as walletIds from "@/lib/wallet-kit/wallet-ids";

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

test("vettedDefaultModules › includes Ledger, built without touching the device", () => {
  const ledgerModule = vettedDefaultModules().find((m) => m.productId === ledger.LEDGER_ID);
  expect(ledgerModule).toBeInstanceOf(ledger.LedgerModule);
});

test("vettedDefaultModules › never includes Trezor, whose constructor loads Trezor Connect", () => {
  expect(vettedDefaultModules().map((m) => m.productId)).not.toContain(TREZOR_ID);
  expect(ALLOWED_DEFAULT_MODULE_IDS).not.toContain(TREZOR_ID);
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

test("wallet ids › each kit-free id is the kit's own", () => {
  const ours: Record<string, string> = { ...walletIds };
  expect(ours).toEqual({
    VARIAL_ID: varial.VARIAL_ID,
    XBULL_ID: xbull.XBULL_ID,
    ALBEDO_ID: albedo.ALBEDO_ID,
    RABET_ID: rabet.RABET_ID,
    HANA_ID: hana.HANA_ID,
    WALLET_CONNECT_ID: walletConnect.WALLET_CONNECT_ID,
    LEDGER_ID: ledger.LEDGER_ID,
  });
  expect(WALLET_CONNECT_WALLET_ID).toBe(walletConnect.WALLET_CONNECT_ID);
});

// WalletConnect is left out: building its module starts a pairing client, so its id is checked
// against the module's own export above.
test("wallet ids › every vetted wallet the app builds has a kit-free id", () => {
  const ids = vettedDefaultModules().map((m) => m.productId);
  const vetted = Object.values(walletIds).filter((id) => id !== walletIds.WALLET_CONNECT_ID);
  expect(ids.sort()).toEqual(vetted.sort());
});
