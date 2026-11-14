import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { within } from "@testing-library/react";
import LandingPage from "@/app/(marketing)/page";
import HowItWorksPage from "@/app/(marketing)/how-it-works/page";
import Faq from "@/components/marketing/Faq";
import { exitCapableProtocols } from "@/lib/contract-registry";
import {
  feature,
  FEATURES,
  LIVE_EXIT_PROTOCOLS,
  listNames,
  PROTOCOLS,
  protocolsWithStatus,
} from "@/lib/site/status";
import { renderMarketing, textOutsideStatusLabels } from "./fixtures/marketing";

const WEB = join(import.meta.dir, "..", "..");
const NOT_LIVE = PROTOCOLS.filter((p) => p.status !== "live");

describe("status registry", () => {
  test("a protocol is live only with an exit-capable mainnet entry", () => {
    const byId = Object.fromEntries(PROTOCOLS.map((p) => [p.id, p.status]));
    expect(byId).toEqual({
      blend: "live",
      soroswap: "live",
      aquarius: "live",
      phoenix: "live",
      fxdao: "testnet-only",
    });
    for (const p of PROTOCOLS) {
      expect(p.status === "live").toBe(exitCapableProtocols("mainnet").has(p.id));
    }
  });

  test("a conversion source is never listed as an exit", () => {
    expect(PROTOCOLS.map((p) => p.name)).not.toContain("xBull");
  });

  test("the allowance inspector is live and links to its route", () => {
    const inspector = feature("allowance-inspector");
    expect(inspector.status).toBe("live");
    expect(inspector.link?.href).toBe("/mainnet/allowances");
    expect(readdirSync(join(WEB, "app", "[network]", "allowances"))).toContain("page.tsx");
  });
});

describe("pages read the registry", () => {
  test("the landing protocol list is exactly the protocols live on mainnet", () => {
    const root = renderMarketing(<LandingPage />);
    const list = within(root).getByRole("list", { name: "Protocol exits live on mainnet" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(names).toEqual(LIVE_EXIT_PROTOCOLS.map((p) => p.name));
    expect(list.closest(".mkt-card")!.textContent).not.toContain("Classic");
    expect(root.textContent).not.toContain("Soroban on the way");
  });

  test("a protocol that is not live appears only beside its status label", () => {
    for (const page of [<LandingPage key="l" />, <HowItWorksPage key="h" />, <Faq key="f" />]) {
      const text = textOutsideStatusLabels(renderMarketing(page));
      for (const p of NOT_LIVE) expect(text).not.toContain(p.name);
    }
  });

  test("the inspector card says Live and links to the inspector", () => {
    const root = renderMarketing(<LandingPage />);
    const link = within(root).getByRole("link", { name: /Open the allowance inspector/ });
    expect(link.getAttribute("href")).toBe("/mainnet/allowances");
    const card = link.closest(".mkt-card")!;
    expect(card.textContent).toContain("Live");
    expect(card.textContent).not.toContain("Soon");
  });

  test("the landing page and the FAQ name the same live protocols and testnet-only items", () => {
    const faq = renderMarketing(<Faq />).textContent ?? "";
    expect(faq).toContain(`exits them in ${listNames(LIVE_EXIT_PROTOCOLS)} on mainnet`);
    const testnetOnly = protocolsWithStatus("testnet-only");
    if (testnetOnly.length > 0) {
      expect(faq).toContain(`${listNames(testnetOnly)} exits run on testnet only`);
      const landing = renderMarketing(<LandingPage />).textContent ?? "";
      expect(landing).toContain(`Testnet only: ${listNames(testnetOnly)}`);
    }
  });

  test("a testnet-only feature is never offered on the landing page as live", () => {
    const root = renderMarketing(<LandingPage />);
    for (const f of FEATURES.filter((f) => f.status !== "live")) {
      const heading = within(root).queryByRole("heading", { name: f.title });
      if (!heading) continue;
      expect(heading.closest(".mkt-card")!.textContent).not.toMatch(/\bLive\b/);
    }
  });
});

describe("no status is written by hand in a page", () => {
  function sources(dir: string): string[] {
    return readdirSync(join(WEB, dir), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
      .map((e) => join(e.parentPath, e.name));
  }

  test("marketing pages and components carry no status literal", () => {
    const files = [...sources("app/(marketing)"), ...sources("components/marketing")];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect({ file, hit: /"(Live|Soon|Testnet only)"|\bstatus: "/.exec(source)?.[0] }).toEqual({
        file,
        hit: undefined,
      });
    }
  });
});
