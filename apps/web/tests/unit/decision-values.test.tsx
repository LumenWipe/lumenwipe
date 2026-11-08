import { beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as navigation from "next/navigation";
import PlanView from "@/components/plan/PlanView";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = "aaaaaaaa";
const DESTINATION = "bbbbbbbb";

const account = {
  address: SOURCE,
  network: "testnet",
  sequence: "1",
  nativeBalanceLumens: "10.0000000",
  dataEntries: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
  numSubEntries: 0,
  numSponsoring: 0,
  sponsoredEntries: [],
  sponsorshipEnumerationIncomplete: false,
  sponsoredBy: null,
  authImmutable: false,
  trustlines: [],
  openOffers: [],
  poolShares: [],
  claimableBalances: [],
  subEntryMismatch: false,
  defiPositions: emptyDefiPositionsResult(SOURCE),
  defiPositionsWarnings: [],
} as unknown as AccountState;

const SWAPPABLE: AssetConvertibility = {
  asset: "SWAP:aaaaaaaa",
  code: "SWAP",
  balance: "5",
  convertible: true,
  quote: { estimatedReceive: "20000000", minAmountOut: "19000000" },
};
const NO_ROUTE: AssetConvertibility = {
  asset: "NORT:aaaaaaaa",
  code: "NORT",
  balance: "5",
  convertible: false,
};
const DUST: AssetConvertibility = {
  asset: "DUST:aaaaaaaa",
  code: "DUST",
  balance: "0.0000001",
  convertible: false,
  dust: true,
};
const STORED_ISSUER: AssetConvertibility = {
  asset: "BACK:aaaaaaaa",
  code: "BACK",
  balance: "5",
  convertible: true,
  quote: { estimatedReceive: "20000000", minAmountOut: "19000000" },
};

function token(code: string, convertible: boolean, decimals: number | null): AssetConvertibility {
  const contract = `C${code}aaaaaaaa`;
  return {
    asset: contract,
    code,
    balance: "5",
    convertible,
    token: {
      contract,
      symbol: code,
      decimals,
      rawBalance: "50000000",
      arrivesFromExit: false,
      ...(convertible
        ? {
            quote: {
              amountOut: "20000000",
              minAmountOut: "19000000",
              platform: "soroswap",
              route: [],
              provider: "soroswap" as const,
              priceImpactBps: 10,
              flags: [],
            },
          }
        : {}),
    },
  };
}
const TOKEN_SWAP = token("TSWP", true, 7);
const TOKEN_NO_ROUTE = token("TNRT", false, 7);
const TOKEN_RAW = token("TRAW", false, null);

function balance(id: string, code: string, currentlyClaimable: boolean): ClaimableBalanceDecision {
  return {
    balanceId: id,
    asset: `${code}:aaaaaaaa`,
    code,
    amount: "3",
    currentlyClaimable,
    predicate: { type: "unconditional" },
    offered: currentlyClaimable ? ["claim", "forfeit"] : ["add_trustline_then_claim", "forfeit"],
    unclaimableNote: null,
  };
}
const CLAIMABLE = balance("aaaaaaaa01", "CLMN", true);
const NO_TRUSTLINE = balance("aaaaaaaa02", "CLMT", false);

interface Seed {
  assetDispositions?: Record<string, AssetDisposition>;
  transferDestinations?: Record<string, string>;
  claimableBalanceSelections?: Record<string, ClaimableBalanceSelection>;
}

async function mount(
  conversions: AssetConvertibility[],
  claims: ClaimableBalanceDecision[] = [],
  seed: Seed = {}
): Promise<void> {
  useDemolishStore.getState().reset();
  useDemolishStore.setState(seed);
  await act(async () => {
    render(
      <PlanView
        account={account}
        conversions={conversions}
        claimableBalanceDecisions={claims}
        blockers={[]}
        planFeeStroops={null}
        network="testnet"
        onRefresh={() => {}}
        loading={false}
      />
    );
  });
  if (claims.length > 0) {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Claim balances/ }));
    });
  }
}

async function choose(name: RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByLabelText(name));
  });
}

function stored() {
  const s = useDemolishStore.getState();
  return {
    assetDispositions: s.assetDispositions,
    transferDestinations: s.transferDestinations,
    claimableBalanceSelections: s.claimableBalanceSelections,
  };
}

beforeEach(() => {
  mock.restore();
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
});

test("swappable asset: Send writes transfer", async () => {
  await mount([SWAPPABLE]);
  await choose(/^Send my 5 SWAP to another account instead/);
  expect(stored().assetDispositions).toEqual({ [SWAPPABLE.asset]: "transfer" });
});

test("swappable asset: Swap writes convert and drops the transfer destination", async () => {
  await mount([SWAPPABLE], [], {
    assetDispositions: { [SWAPPABLE.asset]: "transfer" },
    transferDestinations: { [SWAPPABLE.asset]: DESTINATION },
  });
  await choose(/^Swap my 5 SWAP to XLM/);
  expect(stored().assetDispositions).toEqual({ [SWAPPABLE.asset]: "convert" });
  expect(stored().transferDestinations).toEqual({});
});

test("swappable asset with a stored return: the return option keeps writing issuer", async () => {
  await mount([STORED_ISSUER], [], { assetDispositions: { [STORED_ISSUER.asset]: "issuer" } });
  await choose(/^Return my 5 BACK to the issuer/);
  expect(stored().assetDispositions).toEqual({ [STORED_ISSUER.asset]: "issuer" });
});

test("swappable asset with a stored return: Send writes transfer", async () => {
  await mount([STORED_ISSUER], [], { assetDispositions: { [STORED_ISSUER.asset]: "issuer" } });
  await choose(/^Send my 5 BACK to another account instead/);
  expect(stored().assetDispositions).toEqual({ [STORED_ISSUER.asset]: "transfer" });
});

test("swappable asset with a stored return: Swap writes convert", async () => {
  await mount([STORED_ISSUER], [], { assetDispositions: { [STORED_ISSUER.asset]: "issuer" } });
  await choose(/^Swap my 5 BACK to XLM/);
  expect(stored().assetDispositions).toEqual({ [STORED_ISSUER.asset]: "convert" });
});

test("no-route asset: Return writes issuer", async () => {
  await mount([NO_ROUTE]);
  await choose(/^Return my 5 NORT to the issuer/);
  expect(stored().assetDispositions).toEqual({ [NO_ROUTE.asset]: "issuer" });
});

test("no-route asset: Send writes transfer", async () => {
  await mount([NO_ROUTE]);
  await choose(/^Send my 5 NORT to another account instead/);
  expect(stored().assetDispositions).toEqual({ [NO_ROUTE.asset]: "transfer" });
});

test("no-route asset: Send after Return writes transfer", async () => {
  await mount([NO_ROUTE], [], { assetDispositions: { [NO_ROUTE.asset]: "issuer" } });
  await choose(/^Send my 5 NORT to another account instead/);
  expect(stored().assetDispositions).toEqual({ [NO_ROUTE.asset]: "transfer" });
});

test("no-route asset: Return after Send writes issuer and drops the destination", async () => {
  await mount([NO_ROUTE], [], {
    assetDispositions: { [NO_ROUTE.asset]: "transfer" },
    transferDestinations: { [NO_ROUTE.asset]: DESTINATION },
  });
  await choose(/^Return my 5 NORT to the issuer/);
  expect(stored().assetDispositions).toEqual({ [NO_ROUTE.asset]: "issuer" });
  expect(stored().transferDestinations).toEqual({});
});

for (const [option, value] of [
  [/^Exchange my 5 TSWP for XLM/, "convert"],
  [/^Send my 5 TSWP to another account/, "transfer"],
  [/^Leave my 5 TSWP with this address/, "leave"],
] as const) {
  test(`token with a route: ${option.source} writes ${value}`, async () => {
    await mount([TOKEN_SWAP]);
    await choose(option);
    expect(stored().assetDispositions).toEqual({ [TOKEN_SWAP.asset]: value });
  });
}

for (const [option, value] of [
  [/^Send my 5 TNRT to another account/, "transfer"],
  [/^Leave my 5 TNRT with this address/, "leave"],
] as const) {
  test(`token without a route: ${option.source} writes ${value}`, async () => {
    await mount([TOKEN_NO_ROUTE]);
    await choose(option);
    expect(stored().assetDispositions).toEqual({ [TOKEN_NO_ROUTE.asset]: value });
  });
}

test("token without a route offers no exchange", async () => {
  await mount([TOKEN_NO_ROUTE]);
  expect(screen.queryByLabelText(/^Exchange my/)).toBeNull();
});

test("claimable balance: Leave it unclaimed writes forfeit", async () => {
  await mount([], [CLAIMABLE]);
  await choose(/^Leave it unclaimed/);
  expect(stored().claimableBalanceSelections).toEqual({ [CLAIMABLE.balanceId]: "forfeit" });
});

test("claimable balance: Claim after leaving it writes claim", async () => {
  await mount([], [CLAIMABLE], {
    claimableBalanceSelections: { [CLAIMABLE.balanceId]: "forfeit" },
  });
  await choose(/^Claim( it|$)/);
  expect(stored().claimableBalanceSelections).toEqual({ [CLAIMABLE.balanceId]: "claim" });
});

test("balance without a trustline: Add a trustline writes add_trustline_then_claim", async () => {
  await mount([], [NO_TRUSTLINE]);
  await choose(/^Add a CLMT trustline and claim it/);
  expect(stored().claimableBalanceSelections).toEqual({
    [NO_TRUSTLINE.balanceId]: "add_trustline_then_claim",
  });
  expect(stored().assetDispositions).toEqual({ [NO_TRUSTLINE.asset]: "convert" });
});

test("balance without a trustline: Leave it unclaimed writes forfeit", async () => {
  await mount([], [NO_TRUSTLINE]);
  await choose(/^Leave it unclaimed/);
  expect(stored().claimableBalanceSelections).toEqual({ [NO_TRUSTLINE.balanceId]: "forfeit" });
  expect(stored().assetDispositions).toEqual({});
});

const TRUSTLINE_NOTICE = /must already hold a (SWAP|NORT) trustline/;

for (const [item, away] of [
  [SWAPPABLE, /^Swap my 5 SWAP to XLM/],
  [NO_ROUTE, /^Return my 5 NORT to the issuer/],
] as const) {
  test(`${item.code}: the trustline notice comes and goes with the transfer option`, async () => {
    await mount([item]);
    expect(screen.queryByText(TRUSTLINE_NOTICE)).toBeNull();

    await choose(new RegExp(`^Send my 5 ${item.code} to another account instead`));
    const text = screen.getByText(TRUSTLINE_NOTICE);
    expect(text.className).toContain("text-warning");
    const notice = text.closest('[role="status"]') as HTMLElement;
    expect(notice).not.toBeNull();
    const field = screen.getByRole("textbox", { name: `Destination account for ${item.code}` });
    expect(notice.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryAllByText(TRUSTLINE_NOTICE)).toHaveLength(1);
    expect(
      screen.queryAllByRole("alert").some((a) => TRUSTLINE_NOTICE.test(a.textContent ?? ""))
    ).toBe(false);

    await choose(away);
    expect(screen.queryByText(TRUSTLINE_NOTICE)).toBeNull();
  });
}

test("the default answer per asset type is unchanged", async () => {
  await mount(
    [SWAPPABLE, NO_ROUTE, DUST, STORED_ISSUER, TOKEN_SWAP, TOKEN_NO_ROUTE, TOKEN_RAW],
    [CLAIMABLE, NO_TRUSTLINE],
    { assetDispositions: { [STORED_ISSUER.asset]: "issuer" } }
  );
  expect(stored()).toMatchInlineSnapshot(`
    {
      "assetDispositions": {
        "BACK:aaaaaaaa": "issuer",
        "SWAP:aaaaaaaa": "convert",
      },
      "claimableBalanceSelections": {
        "aaaaaaaa01": "claim",
      },
      "transferDestinations": {},
    }
  `);
});

test("each card checks the option its default answer names", async () => {
  await mount(
    [SWAPPABLE, NO_ROUTE, DUST, STORED_ISSUER, TOKEN_SWAP, TOKEN_NO_ROUTE, TOKEN_RAW],
    [CLAIMABLE, NO_TRUSTLINE],
    { assetDispositions: { [STORED_ISSUER.asset]: "issuer" } }
  );
  const checked = Object.fromEntries(
    screen
      .getAllByRole("group")
      .map((group) => [
        group.querySelector("legend")?.textContent,
        (group.querySelector("input:checked") as HTMLInputElement | null)?.value ?? null,
      ])
  );
  expect(checked).toMatchInlineSnapshot(`
    {
      "Memo type": "text",
      "What happens to BACK": "issuer",
      "What happens to DUST": null,
      "What happens to NORT": null,
      "What happens to SWAP": "convert",
      "What happens to TNRT": null,
      "What happens to TRAW": null,
      "What happens to TSWP": null,
      "What happens to the 3 CLMN claimable balance issued by aaaaaaaa": "claim",
      "What happens to the 3 CLMT claimable balance issued by aaaaaaaa": null,
    }
  `);
});
