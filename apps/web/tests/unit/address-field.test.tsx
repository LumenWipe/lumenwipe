import { expect, test } from "bun:test";
import { useState, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { AddressField } from "@/components/ui/address-field";
import { addressErrorMessage, isValidGAddress } from "@/lib/utils/validation";

const VALID = Keypair.random().publicKey();
const flipLast = (address: string): string =>
  address.slice(0, -1) + (address.endsWith("A") ? "B" : "A");

function Harness({ emitted }: { emitted: string[] }): ReactElement {
  const [value, setValue] = useState("");
  return (
    <AddressField
      label="Account"
      value={value}
      onChange={(next) => {
        emitted.push(next);
        setValue(next);
      }}
      helper="Where it goes"
    />
  );
}

function paste(input: HTMLElement, value: string): void {
  fireEvent.paste(input);
  fireEvent.change(input, { target: { value } });
}

test("addressErrorMessage is null exactly when isValidGAddress accepts", () => {
  expect(addressErrorMessage(VALID)).toBeNull();
  for (const bad of ["", "G", flipLast(VALID), VALID + "A", ` ${VALID}`]) {
    expect(isValidGAddress(bad)).toBe(false);
    expect(addressErrorMessage(bad)).not.toBeNull();
  }
});

test("length, prefix and checksum each get their own message", () => {
  const length = addressErrorMessage(VALID.slice(0, 40));
  const prefix = addressErrorMessage("X" + VALID.slice(1));
  const checksum = addressErrorMessage(flipLast(VALID));
  expect(length).toContain("56 characters");
  expect(length).toContain("40");
  expect(prefix).toContain("starts with G");
  expect(checksum).toContain("checksum");
  expect(new Set([length, prefix, checksum]).size).toBe(3);
});

test("a pasted S-prefixed value is refused without being echoed", () => {
  const pasted = "S" + "AAAAAAAA".repeat(6) + "AAAAAAA";
  const message = addressErrorMessage(pasted) as string;
  expect(message).toContain("starts with G");
  expect(message).not.toContain("AAAA");
});

test("a pasted address with surrounding spaces and a newline is accepted, unchanged inside", () => {
  const emitted: string[] = [];
  render(<Harness emitted={emitted} />);
  const input = screen.getByLabelText("Account") as HTMLInputElement;

  paste(input, `  ${VALID} \t\n`);

  expect(emitted).toEqual([VALID]);
  expect(input.value).toBe(VALID);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input.hasAttribute("aria-invalid")).toBe(false);
});

test("a whitespace change inside the value is left for the validator to refuse", () => {
  const emitted: string[] = [];
  render(<Harness emitted={emitted} />);
  const inner = `${VALID.slice(0, 10)} ${VALID.slice(10)}`;

  paste(screen.getByLabelText("Account"), inner);

  expect(emitted).toEqual([inner]);
  expect(screen.getByRole("alert")).toBeDefined();
});

test("case is never normalized", () => {
  const emitted: string[] = [];
  render(<Harness emitted={emitted} />);

  paste(screen.getByLabelText("Account"), VALID.toLowerCase());

  expect(emitted).toEqual([VALID.toLowerCase()]);
  expect(screen.getByRole("alert").textContent).toContain("starts with G");
});

test.each([
  ["length", VALID.slice(0, 40), "56 characters"],
  ["prefix", "X" + VALID.slice(1), "starts with G"],
  ["checksum", flipLast(VALID), "checksum"],
])("a %s error is one alert the input points at", (_, value, text) => {
  render(<Harness emitted={[]} />);
  const input = screen.getByLabelText("Account");

  paste(input, value);

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain(text);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const ids = (input.getAttribute("aria-describedby") as string).split(" ");
  expect(ids[0]).toBe(alert.id);
  expect(ids.every((id) => document.getElementById(id) !== null)).toBe(true);
});

test("typing raises no error until the field is left", () => {
  render(<Harness emitted={[]} />);
  const input = screen.getByLabelText("Account");

  fireEvent.change(input, { target: { value: "GABC" } });
  expect(screen.queryByRole("alert")).toBeNull();

  fireEvent.blur(input);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});

test("an empty field left behind shows no error", () => {
  render(<Harness emitted={[]} />);
  fireEvent.blur(screen.getByLabelText("Account"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a supplied error replaces the revealed one rather than adding a second", () => {
  render(<AddressField label="Account" value="GABC" onChange={() => {}} error="Supplied" />);
  fireEvent.blur(screen.getByLabelText("Account"));
  expect(screen.getByRole("alert").textContent).toBe("Supplied");
});

test("the placeholder and the input protections are carried through", () => {
  render(<AddressField label="Account" value="" onChange={() => {}} placeholder="G... (x)" />);
  const input = screen.getByPlaceholderText("G... (x)");
  expect(input.getAttribute("autocomplete")).toBe("off");
  expect(input.getAttribute("spellcheck")).toBe("false");
  expect(input.className).toContain("font-mono");
});
