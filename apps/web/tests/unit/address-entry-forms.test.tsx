import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { useState, type ReactElement } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AccountEntryForm from "@/components/account-entry/AccountEntryForm";
import DestinationInput from "@/components/account-entry/DestinationInput";
import HeroAccountInput from "@/components/marketing/HeroAccountInput";
import AssetDispositionCard from "@/components/plan/AssetDispositionCard";
import TokenDispositionCard from "@/components/plan/TokenDispositionCard";
import * as walletKit from "@/hooks/useWalletKitConnection";
import * as recovery from "@/lib/session/recovery";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";
import { expectSameElement } from "./fixtures/focus";

const VALID = Keypair.random().publicKey();
const CHECKSUM_TYPO = VALID.slice(0, -1) + (VALID.endsWith("A") ? "B" : "A");
const ASSET = "USDC:GISSUER";

let push: ReturnType<typeof mock>;

beforeEach(() => {
  push = mock(() => {});
  spyOn(navigation, "useRouter").mockReturnValue({ push } as never);
  useDemolishStore.getState().reset();
});

afterEach(() => mock.restore());

function describedText(input: HTMLElement): string {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function StoreBackedAssetCard(): ReactElement {
  const stored = useDemolishStore((s) => s.transferDestinations[ASSET]);
  const setTransferDestination = useDemolishStore((s) => s.setTransferDestination);
  return (
    <AssetDispositionCard
      item={{ asset: ASSET, code: "USDC", balance: "5", convertible: true }}
      disposition="transfer"
      transferDestination={stored}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={setTransferDestination}
    />
  );
}

function StoreBackedTokenCard(): ReactElement {
  const stored = useDemolishStore((s) => s.transferDestinations[ASSET]);
  const setTransferDestination = useDemolishStore((s) => s.setTransferDestination);
  const item = {
    asset: ASSET,
    code: "USDC",
    balance: "5",
    convertible: false,
    token: { contract: "CTOKEN", decimals: 7 },
  } as unknown as AssetConvertibility;
  return (
    <TokenDispositionCard
      item={item}
      disposition="transfer"
      transferDestination={stored}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={setTransferDestination}
      impactConfirmed={false}
      onConfirmImpact={() => {}}
    />
  );
}

const cards = [
  ["asset", StoreBackedAssetCard],
  ["token", StoreBackedTokenCard],
] as const;

test.each(cards)("the %s card stores the address trimmed and otherwise exact", (_, Card) => {
  render(<Card />);
  const input = screen.getByRole("textbox", { name: "Destination account for USDC" });

  for (const pasted of [
    ` ${VALID}`,
    `${VALID} `,
    `\t${VALID}\t`,
    `\n${VALID}\n`,
    ` \t\n${VALID}\n`,
  ]) {
    act(() => useDemolishStore.getState().setTransferDestination(ASSET, null));
    fireEvent.change(input, { target: { value: pasted } });
    expect(useDemolishStore.getState().transferDestinations[ASSET]).toBe(VALID);
  }
});

test.each(cards)("the %s card never changes a character inside the value", (_, Card) => {
  render(<Card />);
  const input = screen.getByRole("textbox", { name: "Destination account for USDC" });
  const inner = `${VALID.slice(0, 20)}\t${VALID.slice(20, 30).toLowerCase()} ${VALID.slice(30)}`;

  fireEvent.change(input, { target: { value: `  ${inner}\n` } });

  expect(useDemolishStore.getState().transferDestinations[ASSET]).toBe(inner);
});

test.each(cards)("the %s card drops the entry when only whitespace is left", (_, Card) => {
  useDemolishStore.getState().setTransferDestination(ASSET, VALID);
  render(<Card />);
  fireEvent.change(screen.getByRole("textbox", { name: /Destination account/ }), {
    target: { value: " \n" },
  });
  expect(useDemolishStore.getState().transferDestinations[ASSET]).toBeUndefined();
});

test.each(cards)(
  "the %s card shows a stored bad address at once, as one linked alert",
  (_, Card) => {
    useDemolishStore.getState().setTransferDestination(ASSET, CHECKSUM_TYPO);
    render(<Card />);
    const input = screen.getByRole("textbox", { name: /Destination account/ });
    const alert = screen.getByRole("alert");

    expect(alert.textContent).toContain("checksum");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    fireEvent.blur(input);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  }
);

test("the hero field is named and carries the visible placeholder", () => {
  render(<HeroAccountInput />);
  const input = screen.getByRole("textbox", { name: "Stellar account address" });
  expect(input.getAttribute("placeholder")).toBe("Paste a Stellar account address - G…");
});

test("the hero refuses a checksum typo the shape check used to pass", () => {
  render(<HeroAccountInput />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: CHECKSUM_TYPO } });
  fireEvent.click(screen.getByRole("button", { name: "Analyze account" }));

  expect(push).not.toHaveBeenCalled();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("checksum");
  expect(describedText(screen.getByRole("textbox"))).toContain("checksum");
});

test("the hero sends a pasted address on, trimmed, to the same route", () => {
  render(<HeroAccountInput />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: ` ${VALID}\n` } });
  fireEvent.click(screen.getByRole("button", { name: "Analyze account" }));

  expect(push).toHaveBeenCalledWith(`/mainnet/analyze?source=${VALID}`);
  expect(useDemolishStore.getState().sessionId).toBeNull();
});

test("the hero asks for an address on an empty submit and drops the error on the next edit", () => {
  render(<HeroAccountInput />);
  fireEvent.click(screen.getByRole("button", { name: "Analyze account" }));
  expect(screen.getByRole("alert").textContent).toContain("Enter a Stellar account address.");

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "G" } });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the paste-an-address entry is named and keeps its placeholder", () => {
  spyOn(walletKit, "useWalletKitConnection").mockReturnValue({
    address: null,
    status: "connected",
    checking: false,
    network: "yes",
    networkConfirmed: false,
    confirmNetwork: () => {},
    verified: true,
  } as never);
  render(<AccountEntryForm />);
  fireEvent.click(screen.getByRole("tab", { name: "Paste address" }));

  const input = screen.getByRole("textbox", { name: "Account to close" });
  expect(input.getAttribute("placeholder")).toBe("G... (the account to merge)");

  fireEvent.change(input, { target: { value: `${VALID} ` } });
  expect((input as HTMLInputElement).value).toBe(VALID);
  expect(
    (screen.getByRole("button", { name: "Analyze account" }) as HTMLButtonElement).disabled
  ).toBe(false);
});

function renderEntryForm(address: string | null = null): ReturnType<typeof mock> {
  const connect = mock(async () => {});
  useNetworkStore.setState({ network: "testnet" });
  spyOn(walletKit, "useWalletKitConnection").mockReturnValue({
    address,
    status: "connected",
    checking: false,
    network: "yes",
    networkConfirmed: false,
    confirmNetwork: () => {},
    verified: true,
    connect,
    disconnect: async () => {},
  } as never);
  render(<AccountEntryForm />);
  return connect;
}

async function analyze(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Analyze account" }));
  });
}

test("the entry switch sends the connected wallet to analysis, the default mode", async () => {
  spyOn(recovery, "findUnresolved").mockResolvedValue(null as never);
  const wallet = Keypair.random().publicKey();
  renderEntryForm(wallet);
  expect(screen.getByRole("tab", { name: "Connect wallet" }).getAttribute("aria-selected")).toBe(
    "true"
  );
  await analyze();
  expect(push.mock.calls).toEqual([[`/testnet/analyze?source=${wallet}`]]);
});

test("the entry switch sends the pasted address, not the wallet, in address mode", async () => {
  spyOn(recovery, "findUnresolved").mockResolvedValue(null as never);
  renderEntryForm(Keypair.random().publicKey());
  fireEvent.keyDown(screen.getByRole("tab", { name: "Connect wallet" }), { key: "ArrowRight" });
  fireEvent.change(screen.getByRole("textbox", { name: "Account to close" }), {
    target: { value: VALID },
  });
  await analyze();
  expect(push.mock.calls).toEqual([[`/testnet/analyze?source=${VALID}`]]);
});

test("a pasted address survives leaving and returning to address mode", () => {
  renderEntryForm();
  const pasteTab = screen.getByRole("tab", { name: "Paste address" });
  fireEvent.click(pasteTab);
  fireEvent.change(screen.getByRole("textbox", { name: "Account to close" }), {
    target: { value: VALID },
  });
  fireEvent.keyDown(pasteTab, { key: "ArrowLeft" });
  expect(screen.queryByRole("textbox", { name: "Account to close" })).toBeNull();
  fireEvent.click(pasteTab);
  expect(
    (screen.getByRole("textbox", { name: "Account to close" }) as HTMLInputElement).value
  ).toBe(VALID);
});

test("reselecting the active entry mode changes nothing", () => {
  const connect = renderEntryForm();
  fireEvent.click(screen.getByRole("tab", { name: "Paste address" }));
  const input = screen.getByRole("textbox", { name: "Account to close" });
  fireEvent.change(input, { target: { value: VALID } });

  fireEvent.click(screen.getByRole("tab", { name: "Paste address" }));

  expectSameElement(screen.getByRole("textbox", { name: "Account to close" }), input);
  expect((input as HTMLInputElement).value).toBe(VALID);
  expect(connect).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});

function destinationInput(onDestinationChange: (value: string) => void = () => {}): ReactElement {
  return (
    <DestinationInput
      destination=""
      onDestinationChange={onDestinationChange}
      memo=""
      onMemoChange={() => {}}
      memoType="text"
      onMemoTypeChange={() => {}}
      source=""
      acknowledged={false}
      onAcknowledgedChange={() => {}}
    />
  );
}

test("the destination is named, keeps its placeholder and emits the trimmed value", () => {
  const seen: string[] = [];
  render(destinationInput((value) => seen.push(value)));

  const input = screen.getByRole("textbox", { name: "Destination address" });
  expect(input.getAttribute("placeholder")).toBe("G... (where to send your XLM)");

  fireEvent.change(input, { target: { value: ` ${VALID}\n` } });
  expect(seen).toEqual([VALID]);
});

test("the memo is named, described, and passes its value through untouched", () => {
  const seen: string[] = [];
  render(
    <DestinationInput
      destination=""
      onDestinationChange={() => {}}
      memo=""
      onMemoChange={(value) => seen.push(value)}
      memoType="text"
      onMemoTypeChange={() => {}}
      source=""
      acknowledged={false}
      onAcknowledgedChange={() => {}}
    />
  );

  const input = screen.getByRole("textbox", { name: /Payment memo/ });
  expect(input.getAttribute("placeholder")).toBe("Enter memo text (max 28 bytes)");
  expect(describedText(input)).toContain("Required by most exchanges");

  fireEvent.change(input, { target: { value: " 12 " } });
  expect(seen).toEqual([" 12 "]);
});

test("each entry field reports a valid address as text", () => {
  render(<HeroAccountInput />);
  const hero = screen.getByRole("textbox", { name: "Stellar account address" });
  fireEvent.change(hero, { target: { value: VALID } });
  fireEvent.blur(hero);
  expect(describedText(hero)).toContain("Valid address");
});

test("the destination reports a valid address as text alongside its helper", () => {
  function Controlled(): ReactElement {
    const [destination, setDestination] = useState("");
    return (
      <DestinationInput
        destination={destination}
        onDestinationChange={setDestination}
        memo=""
        onMemoChange={() => {}}
        memoType="text"
        onMemoTypeChange={() => {}}
        source=""
        acknowledged={false}
        onAcknowledgedChange={() => {}}
      />
    );
  }
  render(<Controlled />);
  const input = screen.getByRole("textbox", { name: "Destination address" });
  fireEvent.change(input, { target: { value: VALID } });
  fireEvent.blur(input);
  expect(describedText(input)).toContain("Valid address");
  expect(describedText(input)).toContain("All XLM from the merged account");
});

// Synthetic: the shape of a secret seed with a checksum that does not match, never a real key.
const SECRET_SHAPED = "S" + "A".repeat(55);
const WARNING = "That looks like a secret key. Never paste it here.";

function pasteText(input: HTMLElement, text: string): void {
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

/** The key is in no field, no rendered text and no attribute, the warning shows, and nothing was
 *  logged or sent. */
function expectRefused(input: HTMLElement, logs: ReturnType<typeof spyOn>[]): void {
  expect((input as HTMLInputElement).value).toBe("");
  expect(document.body.innerHTML).not.toContain(SECRET_SHAPED);
  expect(document.body.textContent).toContain(WARNING);
  expect(push).not.toHaveBeenCalled();
  for (const log of logs) {
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET_SHAPED);
  }
}

function spyLogs(): ReturnType<typeof spyOn>[] {
  return (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation(() => {})
  );
}

const refusalPaths = [
  ["pasted", (input: HTMLElement) => pasteText(input, ` ${SECRET_SHAPED}\n`)],
  [
    "typed or dropped",
    (input: HTMLElement) => fireEvent.change(input, { target: { value: SECRET_SHAPED } }),
  ],
] as const;

test.each(refusalPaths)("the hero refuses a %s secret key and analyzes nothing", (_, enter) => {
  const logs = spyLogs();
  const fetchSpy = spyOn(globalThis, "fetch");
  render(<HeroAccountInput />);
  const input = screen.getByRole("textbox", { name: "Stellar account address" });

  enter(input);
  fireEvent.click(screen.getByRole("button", { name: "Analyze account" }));

  expectRefused(input, logs);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test.each(refusalPaths)("the account entry refuses a %s secret key", async (_, enter) => {
  const logs = spyLogs();
  const fetchSpy = spyOn(globalThis, "fetch");
  const find = spyOn(recovery, "findUnresolved").mockResolvedValue(null as never);
  renderEntryForm();
  fireEvent.click(screen.getByRole("tab", { name: "Paste address" }));
  const input = screen.getByRole("textbox", { name: "Account to close" });

  enter(input);
  await analyze();

  expectRefused(input, logs);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
});

test.each(cards)("the %s card refuses a pasted secret key and stores nothing", (_, Card) => {
  const logs = spyLogs();
  render(<Card />);
  const input = screen.getByRole("textbox", { name: "Destination account for USDC" });

  for (const [, enter] of refusalPaths) {
    enter(input);
    expectRefused(input, logs);
    expect(useDemolishStore.getState().transferDestinations[ASSET]).toBeUndefined();
    expect(JSON.stringify(useDemolishStore.getState())).not.toContain(SECRET_SHAPED);
  }
});

test("the destination refuses a pasted secret key, and a real address clears the warning", () => {
  const seen: string[] = [];
  function Controlled(): ReactElement {
    const [destination, setDestination] = useState("");
    return (
      <DestinationInput
        destination={destination}
        onDestinationChange={(value) => {
          seen.push(value);
          setDestination(value);
        }}
        memo=""
        onMemoChange={() => {}}
        memoType="text"
        onMemoTypeChange={() => {}}
        source=""
        acknowledged={false}
        onAcknowledgedChange={() => {}}
      />
    );
  }
  render(<Controlled />);
  const input = screen.getByRole("textbox", { name: "Destination address" });

  pasteText(input, SECRET_SHAPED);
  expectRefused(input, []);
  expect(screen.getByRole("alert").textContent).toContain(WARNING);

  fireEvent.change(input, { target: { value: VALID } });
  expect(document.body.textContent).not.toContain(WARNING);
  expect(seen).not.toContain(SECRET_SHAPED);
});

test("a secret key pasted after what the field already holds is refused too", () => {
  render(<HeroAccountInput />);
  const input = screen.getByRole("textbox", { name: "Stellar account address" });
  fireEvent.change(input, { target: { value: "GABC" } });

  fireEvent.change(input, { target: { value: `GABC ${SECRET_SHAPED}` } });

  expectRefused(input, []);
});
