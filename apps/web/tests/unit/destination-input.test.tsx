import { expect, test } from "bun:test";
import { useState, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import DestinationInput from "@/components/account-entry/DestinationInput";
import { activeRegistry } from "@/lib/exchange-registry";
import type { ChosenMemoType } from "@/lib/plan/memo-field";

const noop = (): void => {};

function renderInput(destination: string): void {
  render(
    <DestinationInput
      destination={destination}
      onDestinationChange={noop}
      memo=""
      onMemoChange={noop}
      memoType="text"
      onMemoTypeChange={() => {}}
      source={Keypair.random().publicKey()}
      acknowledged={false}
      onAcknowledgedChange={noop}
    />
  );
}

test("an unrecognized destination raises one alert carrying the warning and its checkbox", () => {
  renderInput(Keypair.random().publicKey());

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("We don't recognize this address");
  expect(alert.contains(screen.getByRole("checkbox"))).toBe(true);
});

test("no alert is raised before the destination is a valid address", () => {
  renderInput("GABC");
  expect(screen.queryByRole("alert")).toBeNull();
});

const UNLISTED = Keypair.random().publicKey();
const exchange = (type: "text" | "id") => {
  const entry = activeRegistry().entries.find((e) => e.requiresMemo && e.memoType === type);
  if (!entry) throw new Error(`no ${type} exchange`);
  return entry;
};

function Controlled({
  destination,
  initialMemo = "",
  types = [],
}: {
  destination: string;
  initialMemo?: string;
  types?: ChosenMemoType[];
}): ReactElement {
  const [memo, setMemo] = useState(initialMemo);
  const [memoType, setMemoType] = useState<ChosenMemoType>("text");
  return (
    <DestinationInput
      destination={destination}
      onDestinationChange={noop}
      memo={memo}
      onMemoChange={setMemo}
      memoType={memoType}
      onMemoTypeChange={(type) => {
        types.push(type);
        setMemoType(type);
      }}
      source={Keypair.random().publicKey()}
      acknowledged
      onAcknowledgedChange={noop}
    />
  );
}

const memoInput = () => screen.getByRole("textbox", { name: /Payment memo/ }) as HTMLInputElement;

test("the memo counts bytes live and limits nothing as it is typed", () => {
  render(<Controlled destination={UNLISTED} />);
  const input = memoInput();
  expect(input.getAttribute("maxlength")).toBeNull();
  expect(input.getAttribute("type")).toBe("text");

  fireEvent.change(input, { target: { value: "€".repeat(10) } });

  expect(input.value).toBe("€".repeat(10));
  expect(screen.getByText("30 / 28 bytes")).toBeDefined();
});

test("a memo over the limit shows its error once the field is left", () => {
  render(<Controlled destination={UNLISTED} />);
  const input = memoInput();
  fireEvent.change(input, { target: { value: "€".repeat(10) } });
  expect(screen.queryByText(/A text memo holds at most 28/)).toBeNull();

  fireEvent.blur(input);

  expect(screen.getByText("This memo is 30 bytes. A text memo holds at most 28.")).toBeDefined();
  expect(input.getAttribute("aria-invalid")).toBe("true");
});

test("an unlisted destination offers a text or id choice, and the choice is reported", () => {
  const types: ChosenMemoType[] = [];
  render(<Controlled destination={UNLISTED} types={types} />);

  fireEvent.click(screen.getByRole("radio", { name: "ID (numbers only)" }));

  expect(types).toEqual(["id"]);
  expect(memoInput().getAttribute("inputmode")).toBe("numeric");
  expect(memoInput().getAttribute("type")).toBe("text");
});

test("a listed exchange takes its own memo type, with no choice offered", () => {
  render(<Controlled destination={exchange("id").address} />);
  expect(screen.queryByRole("radio")).toBeNull();
  expect(memoInput().getAttribute("inputmode")).toBe("numeric");
});

test("an id memo refuses a non-digit edit whole instead of stripping it", () => {
  render(<Controlled destination={exchange("id").address} initialMemo="12" />);
  const input = memoInput();

  fireEvent.change(input, { target: { value: "12a" } });

  expect(input.value).toBe("12");
  expect(screen.getByRole("alert").textContent).toContain("An id memo is digits only.");

  fireEvent.change(input, { target: { value: "123" } });
  expect(input.value).toBe("123");
  expect(screen.queryByText("An id memo is digits only.")).toBeNull();
});

test("an id memo with a leading zero is refused, not rewritten", () => {
  render(<Controlled destination={exchange("id").address} />);
  const input = memoInput();
  fireEvent.change(input, { target: { value: "007" } });
  fireEvent.blur(input);
  expect(input.value).toBe("007");
  expect(screen.getByText("An id memo cannot start with 0.")).toBeDefined();
});

test("a required memo left empty says the exchange needs one", () => {
  render(<Controlled destination={exchange("text").address} />);
  fireEvent.blur(memoInput());
  expect(screen.getByText("This exchange needs a memo.")).toBeDefined();
});
