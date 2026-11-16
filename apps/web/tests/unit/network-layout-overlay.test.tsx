import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import * as navigation from "next/navigation";
import * as statsHook from "@/hooks/useStats";
import NetworkLayout from "@/app/[network]/layout";
import { useDemolishStore } from "@/store/demolish";

const STATS = { testnet: 12, mainnet: 3, mainnetXlmStroops: "1000000000" };

function renderLayout(network: string, pathname: string): ReturnType<typeof render> {
  spyOn(navigation, "useRouter").mockReturnValue({ push: () => {}, replace: () => {} } as never);
  spyOn(navigation, "usePathname").mockReturnValue(pathname);
  spyOn(navigation, "useSearchParams").mockReturnValue(new URLSearchParams() as never);
  spyOn(statsHook, "useStats").mockReturnValue({
    stats: STATS,
    stale: false,
  } as ReturnType<typeof statsHook.useStats>);
  const params = Object.assign(Promise.resolve({ network }), {
    status: "fulfilled",
    value: { network },
  });
  return render(
    <NetworkLayout params={params}>
      <p>page</p>
    </NetworkLayout>
  );
}

// No account is open, so the layout reads no saved close: this file is about the overlay.
beforeEach(() => {
  useDemolishStore.getState().reset();
});

afterEach(() => {
  cleanup();
  mock.restore();
});

for (const network of ["mainnet", "testnet"]) {
  for (const route of ["review", "execute", "complete"]) {
    test(`network layout › hides the stats overlay on /${network}/${route}`, () => {
      const { container } = renderLayout(network, `/${network}/${route}`);
      expect(container.textContent).not.toContain("Live stats");
      expect(container.textContent).not.toContain("recovered on mainnet");
      expect(container.querySelector("main")?.className).not.toContain("pb-16");
    });
  }

  for (const route of ["", "/analyze"]) {
    test(`network layout › shows the stats overlay on /${network}${route}`, () => {
      const { container } = renderLayout(network, `/${network}${route}`);
      expect(container.textContent).toContain("Live stats");
      expect(container.querySelector("main")?.className).toContain("pb-16");
    });
  }
}

test("network stats pill › stays on one line", () => {
  const { container } = renderLayout("mainnet", "/mainnet");
  const pill = container.querySelector("div.xl\\:hidden > div");
  expect(pill?.className).toContain("whitespace-nowrap");
  expect(pill?.className).not.toContain("flex-wrap");
});
