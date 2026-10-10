import { afterEach, expect, spyOn, test, mock } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as navigation from "next/navigation";
import AddressInput from "@/components/account-entry/AddressInput";
import HeroAccountInput from "@/components/marketing/HeroAccountInput";

afterEach(() => {
  cleanup();
  mock.restore();
});

test("the address field leaves the browser outline to the global focus rule", () => {
  const { container } = render(<AddressInput label="Account" value="" onChange={() => {}} />);
  const input = container.querySelector("input") as HTMLInputElement;
  expect(input.className).not.toContain("outline-none");
  expect(input.className).not.toMatch(/focus:ring/);
});

test("the hero field shows a keyboard focus ring on its group instead of its own", () => {
  spyOn(navigation, "useRouter").mockReturnValue({ push: () => {} } as never);
  const { container } = render(<HeroAccountInput />);
  const input = container.querySelector("input") as HTMLInputElement;
  const group = input.parentElement as HTMLElement;
  expect(input.className).toContain("focus-visible:outline-none");
  expect(group.className).toContain("has-[input:focus-visible]:outline-focus");
});
