import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { render, screen, waitFor, within } from "@testing-library/react";
import RegistryPage from "@/app/(marketing)/registry/page";
import RegistryClient from "@/components/marketing/registry/RegistryClient";
import {
  activeRegistry,
  bundledRegistry,
  setRegistry,
  type RegistrySnapshot,
} from "@/lib/exchange-registry";
import { PROTOCOLS, PROTOCOLS_VERIFIED, STATUS_LABEL } from "@/lib/site/status";

const BUNDLED = bundledRegistry();
const at = (iso: string) => () => new Date(iso);
/** One second after the last moment `date` is still relied on. */
const justAfter = (date: string) => () => new Date(Date.parse(`${date}T23:59:59Z`) + 1000);

function served(over: Partial<RegistrySnapshot> = {}): RegistrySnapshot {
  return { ...BUNDLED, served: true, lastVerified: "2026-11-01", ...over };
}

afterEach(() => setRegistry(BUNDLED));

describe("the prerendered markup", () => {
  const html = renderToString(<RegistryPage />);

  test("lists the bundled exchanges, every protocol and both verification dates", () => {
    for (const entry of BUNDLED.entries) expect(html).toContain(entry.address);
    for (const protocol of PROTOCOLS) expect(html).toContain(protocol.name);
    expect(html).toContain(BUNDLED.validUntil);
    expect(html).toContain(PROTOCOLS_VERIFIED.lastVerified);
  });

  test("states no freshness verdict, since it was rendered at build time", () => {
    expect(html).not.toContain("Current.");
    expect(html).not.toContain("not current");
  });
});

describe("the registry", () => {
  test("shows the API's copy once read, and calls both lists current before validUntil", async () => {
    render(<RegistryClient load={async () => served()} clock={at("2026-11-16T12:00:00Z")} />);
    await screen.findByText("Shown: the API's copy, read when this page loaded.");
    expect(screen.getAllByText("Current.")).toHaveLength(2);
    expect(screen.getByText(/2026-11-01/)).toBeTruthy();
  });

  test("falls back to the bundled copy, and says so, when the API's copy cannot be read", async () => {
    render(<RegistryClient load={async () => null} clock={at("2026-11-16T12:00:00Z")} />);
    await screen.findByText(
      "The API's copy could not be read. Shown: the copy shipped with this site."
    );
    expect(screen.getByText(BUNDLED.entries[0].address)).toBeTruthy();
  });

  test("past validUntil the exchange list says it is not current instead of presenting it as current", async () => {
    render(
      <RegistryClient
        load={async () => served({ validUntil: "2026-12-01" })}
        clock={justAfter("2026-12-01")}
      />
    );
    await screen.findByText(/This list is past 2026-12-01.*not current/);
    const exchanges = screen.getByRole("heading", {
      name: "Exchanges and memo rules",
    }).parentElement;
    expect(exchanges?.textContent).toContain("refuses exchange closes");
    expect(exchanges?.textContent).not.toContain("Current.");
  });

  test("past the contract list's validUntil the protocol statuses are not presented as current", async () => {
    const until = PROTOCOLS_VERIFIED.validUntil;
    render(
      <RegistryClient
        load={async () => served({ validUntil: "2099-12-31" })}
        clock={justAfter(until)}
      />
    );
    await screen.findByText(new RegExp(`contract list is past ${until}.*not current`));
    expect(screen.getAllByText("Current.")).toHaveLength(1);
  });

  test("every protocol's status comes from the status module", async () => {
    render(<RegistryClient load={async () => null} clock={at("2026-11-16T12:00:00Z")} />);
    await screen.findByText(/could not be read/);
    const table = screen.getByRole("table", { name: /DeFi protocols/ });
    for (const protocol of PROTOCOLS) {
      const row = within(table).getByRole("rowheader", { name: protocol.name }).closest("tr");
      expect(row?.textContent).toContain(STATUS_LABEL[protocol.status]);
    }
  });

  test("offers no action and claims no signature", async () => {
    const { container } = render(
      <RegistryClient load={async () => served()} clock={at("2026-11-16T12:00:00Z")} />
    );
    await screen.findByText("Shown: the API's copy, read when this page loaded.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/signature|signed by|verified copy/i);
    expect(container.textContent).toContain("not signed");
  });

  test("loading the page never changes the snapshot a close is verified against", async () => {
    const before = activeRegistry();
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ...served(), validUntil: "2099-12-31" }), { status: 200 })
    );
    render(<RegistryClient clock={at("2026-11-16T12:00:00Z")} />);
    await screen.findByText("Shown: the API's copy, read when this page loaded.");
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    expect(fetchSpy.mock.calls[0][0]).toBe("/api/config/exchange-registry");
    expect(activeRegistry()).toBe(before);
    fetchSpy.mockRestore();
  });
});
