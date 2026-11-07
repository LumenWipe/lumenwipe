import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import * as navigation from "next/navigation";
import { LeaveGuardProvider } from "@/components/layout/LeaveGuard";
import NavBar from "@/components/layout/NavBar";
import NetworkBadge from "@/components/layout/NetworkBadge";

afterEach(() => mock.restore());

test("the nav names the network at every width: its badge carries no display rule", () => {
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({ push: () => {}, replace: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  render(
    <LeaveGuardProvider>
      <NavBar network="mainnet" />
    </LeaveGuardProvider>
  );
  const badge = within(screen.getByRole("banner")).getByText("MAINNET");
  expect(badge.className.split(/\s+/).some((c) => /(^|:)hidden$/.test(c))).toBe(false);
});

test("the detailed badge says what the network's funds are", () => {
  const { rerender } = render(<NetworkBadge network="mainnet" detailed />);
  expect(screen.getByText("MAINNET: real funds")).toBeDefined();
  rerender(<NetworkBadge network="testnet" detailed />);
  expect(screen.getByText("TESTNET: no real value")).toBeDefined();
});
