import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import embedded from "@registry/exchange-registry.json";
import AssetDispositionCard from "@/components/plan/AssetDispositionCard";
import TokenDispositionCard from "@/components/plan/TokenDispositionCard";
import { activeRegistry, setRegistry } from "@/lib/exchange-registry";
import { assetResolved } from "@/lib/plan/asset-resolution";
import {
  isUsableTransferDestination,
  refusedTransferAsset,
  transferDestinationError,
} from "@/lib/plan/transfer-destination";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";

const EXCHANGE = embedded.entries[0]!;
const WALLET = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const TOKEN = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";

const classic: AssetConvertibility = {
  asset: USDC,
  code: "USDC",
  balance: "5",
  convertible: true,
} as AssetConvertibility;
const token = {
  asset: TOKEN,
  code: "TKN",
  balance: "5",
  convertible: false,
  token: { contract: TOKEN, decimals: 7 },
} as unknown as AssetConvertibility;

function assetCard(destination: string | undefined, merge: string | null) {
  return (
    <AssetDispositionCard
      network="mainnet"
      item={classic}
      disposition="transfer"
      transferDestination={destination}
      mergeDestination={merge}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
    />
  );
}

function tokenCard(destination: string | undefined, merge: string | null) {
  return (
    <TokenDispositionCard
      network="mainnet"
      item={token}
      disposition="transfer"
      transferDestination={destination}
      mergeDestination={merge}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      impactConfirmed={false}
      onConfirmImpact={() => {}}
    />
  );
}

const cards = [
  ["asset", assetCard],
  ["token", tokenCard],
] as const;

afterEach(() => cleanup());

describe("the disposition cards", () => {
  test.each(cards)(
    "the %s card refuses a listed exchange as the destination, naming it",
    (_, card) => {
      render(card(EXCHANGE.address, null));
      expect(
        screen.getByText(new RegExp(`This is a ${EXCHANGE.name} deposit address`))
      ).toBeTruthy();
      expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    }
  );

  test.each(cards)("the %s card accepts a wallet as the destination", (_, card) => {
    render(card(WALLET, null));
    expect(screen.queryByText(/deposit address\. A transfer/)).toBeNull();
    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBeNull();
  });

  test.each(cards)(
    "the %s card offers the merge account as a shortcut only when it is not an exchange",
    (_, card) => {
      const shortcut = "Use the same account I'm merging into";
      render(card(undefined, EXCHANGE.address));
      expect(screen.queryByText(shortcut)).toBeNull();
      cleanup();
      render(card(undefined, WALLET));
      expect(screen.getByText(shortcut)).toBeTruthy();
    }
  );
});

describe("asset resolution", () => {
  test("a transfer to a listed exchange is not an answer, for a classic asset or a token", () => {
    for (const item of [classic, token]) {
      const answers = (destination: string) => ({
        network: "mainnet" as const,
        dispositions: { [item.asset]: "transfer" as const },
        transferDestinations: { [item.asset]: destination },
      });
      expect(assetResolved(item, answers(EXCHANGE.address))).toBe(false);
      expect(assetResolved(item, answers(WALLET))).toBe(true);
    }
  });

  test("a malformed address keeps its own message ahead of the exchange one", () => {
    expect(transferDestinationError("GNOPE", "mainnet")).toBe(
      "A Stellar account address has 56 characters."
    );
    expect(transferDestinationError(WALLET, "mainnet")).toBeNull();
    expect(isUsableTransferDestination(undefined, "mainnet")).toBe(false);
    expect(isUsableTransferDestination(null, "mainnet")).toBe(false);
  });
});

describe("refusedTransferAsset", () => {
  let before: ReturnType<typeof activeRegistry>;
  beforeEach(() => {
    before = activeRegistry();
  });
  afterEach(() => setRegistry(before));

  test("names the asset sent to a listed exchange, and ignores any answer that is not a transfer", () => {
    expect(
      refusedTransferAsset(
        { [USDC]: "issuer", [TOKEN]: "transfer" },
        { [USDC]: EXCHANGE.address, [TOKEN]: WALLET },
        "mainnet"
      )
    ).toBeNull();
    expect(
      refusedTransferAsset(
        { [USDC]: "convert", [TOKEN]: "transfer" },
        { [TOKEN]: EXCHANGE.address },
        "mainnet"
      )
    ).toBe(TOKEN);
    expect(refusedTransferAsset({ [TOKEN]: "transfer" }, {}, "mainnet")).toBeNull();
  });

  test("follows a served entry that lists an address after the plan", () => {
    const answers = [{ [USDC]: "transfer" as const }, { [USDC]: WALLET }] as const;
    expect(refusedTransferAsset(...answers, "mainnet")).toBeNull();
    setRegistry({
      ...before,
      entries: [
        ...before.entries,
        {
          address: WALLET,
          name: "Example Exchange",
          domain: "example.com",
          requiresMediator: false,
          requiresMemo: false,
          memoType: "text",
        },
      ],
    });
    expect(refusedTransferAsset(...answers, "mainnet")).toBe(USDC);
  });
});
