import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, within } from "@testing-library/react";
import LandingPage from "@/app/(marketing)/page";
import { heroOutcome } from "@/lib/site/numbers";
import { feature } from "@/lib/site/status";
import { renderMarketing } from "./fixtures/marketing";

afterEach(() => {
  cleanup();
  mock.restore();
});

const JARGON = /ACCOUNT_MERGE|\bXDR\b|SEP-?43|mediat(?:or|ed|ing)|intermediar(?:y|ies)|demolish/i;

function hero(root: HTMLElement): HTMLElement {
  return root.querySelector("section") as HTMLElement;
}

describe("landing copy", () => {
  test("names no protocol term or other tool", () => {
    const text = renderMarketing(<LandingPage />).textContent ?? "";
    expect(text.match(JARGON)).toBeNull();
  });

  test("the relay account is defined where the page first names it", () => {
    const text = renderMarketing(<LandingPage />).textContent ?? "";
    const definition = feature("exchange-close").summary;
    expect(definition).toMatch(/relay account receives the merge and pays the balance on/);
    expect(text.search(/relay account/i)).toBe(
      text.indexOf(definition) + definition.search(/relay account/i)
    );
  });

  test("the hero leads with the outcome and the recovered amount", () => {
    const section = hero(renderMarketing(<LandingPage />));
    expect(section.textContent).toContain("Recover your locked XLM");
    expect(section.textContent).toMatch(
      /Get back the 1 XLM every account must hold,\s*plus 0.5 XLM/
    );
  });
});

describe("hero outcome line", () => {
  test("claims DeFi exits only while the registry has them live", () => {
    expect(heroOutcome("live")).toContain("exits your DeFi positions");
    for (const status of ["testnet-only", "soon"] as const) {
      expect(heroOutcome(status)).not.toMatch(/DeFi|position/i);
      expect(heroOutcome(status)).toContain("LumenWipe clears them, converts leftover tokens");
    }
  });

  test("the landing page renders the line for the registry's current DeFi status", () => {
    const section = hero(renderMarketing(<LandingPage />));
    expect(section.textContent).toContain(heroOutcome(feature("defi-exits").status));
  });
});

describe("landing hero actions", () => {
  test("the analyzer is the only solid button", () => {
    const section = hero(renderMarketing(<LandingPage />));
    const solid = Array.from(section.querySelectorAll("a, button")).filter((el) =>
      /(?:^|\s)bg-accent(?:\s|$)/.test(el.className)
    );
    expect(solid.map((el) => el.textContent)).toEqual(["Analyze account"]);
  });

  test("Open the app is a text link and the playground sits right under the input", () => {
    const section = hero(renderMarketing(<LandingPage />));
    const open = within(section).getByRole("link", { name: "Open the app" });
    expect(open.getAttribute("href")).toBe("/mainnet");
    expect(open.className).not.toMatch(/(?:^|\s)(?:bg-|border-line-strong)/);

    const input = within(section).getByRole("textbox", { name: "Stellar account address" });
    const playground = within(section).getByRole("link", { name: "Try the playground" });
    expect(playground.getAttribute("href")).toBe("/playground");
    expect(
      input.compareDocumentPosition(playground) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      playground.compareDocumentPosition(open) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test("below sm the input and the button stack at full width", () => {
    const section = hero(renderMarketing(<LandingPage />));
    const input = within(section).getByRole("textbox", { name: "Stellar account address" });
    const group = input.parentElement as HTMLElement;
    expect(group.className.split(" ")).toEqual(
      expect.arrayContaining(["flex-col", "items-stretch", "sm:flex-row"])
    );
    const submit = within(section).getByRole("button", { name: "Analyze account" });
    expect(submit.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "sm:w-auto"]));
  });
});
