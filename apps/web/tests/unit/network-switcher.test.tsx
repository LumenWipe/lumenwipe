import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import NetworkSwitcher from "@/components/layout/NetworkSwitcher";

afterEach(cleanup);

test("stays two links and marks only the current network", () => {
  render(<NetworkSwitcher currentNetwork="testnet" />);
  const mainnet = screen.getByRole("link", { name: "Mainnet" });
  const testnet = screen.getByRole("link", { name: "Testnet" });

  expect(mainnet.getAttribute("href")).toBe("/mainnet");
  expect(testnet.getAttribute("href")).toBe("/testnet");
  expect(testnet.getAttribute("aria-current")).toBe("true");
  expect(mainnet.hasAttribute("aria-current")).toBe(false);
  expect(screen.queryByRole("tab")).toBeNull();
});
