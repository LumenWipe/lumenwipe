import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as navigation from "next/navigation";
import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import Faq from "@/components/marketing/Faq";
import NotFoundView, { REPORT_BROKEN_LINK_URL } from "@/components/marketing/NotFoundView";
import MarketingNotFound from "@/app/(marketing)/not-found";
import BlogPage from "@/app/(marketing)/blog/page";
import * as blog from "@/lib/blog";
import { expectSameElement } from "./fixtures/focus";

let desktop: { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> };
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  spyOn(navigation, "usePathname").mockReturnValue("/");
  desktop = { matches: false, listeners: new Set() };
  window.matchMedia = ((query: string) => ({
    matches: desktop.matches,
    media: query,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) =>
      desktop.listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) =>
      desktop.listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  mock.restore();
  window.matchMedia = realMatchMedia;
  document.body.style.overflow = "";
});

function openMenu(): { toggle: HTMLElement; sheet: HTMLElement } {
  const toggle = screen.getByRole("button", { name: "Open menu" });
  fireEvent.click(toggle);
  const sheet = document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLElement;
  return { toggle, sheet };
}

describe("mobile menu", () => {
  test("the toggle names its action and state and controls the sheet", () => {
    render(<MarketingNav />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const sheet = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(sheet?.hidden).toBe(true);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-label")).toBe("Close menu");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(sheet?.hidden).toBe(false);
  });

  test("opening moves focus into the sheet and locks the page scroll", () => {
    render(<MarketingNav />);
    const { sheet } = openMenu();
    expectSameElement(document.activeElement, within(sheet).getAllByRole("link")[0]);
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("Tab wraps between the last item and the toggle, both ways", () => {
    render(<MarketingNav />);
    const { toggle, sheet } = openMenu();
    const items = within(sheet).getAllByRole("link");
    const last = items[items.length - 1]!;

    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expectSameElement(document.activeElement, toggle);

    expect(fireEvent.keyDown(toggle, { key: "Tab", shiftKey: true })).toBe(false);
    expectSameElement(document.activeElement, last);
  });

  test("Escape closes the sheet, returns focus to the toggle and releases the scroll", () => {
    render(<MarketingNav />);
    const { toggle, sheet } = openMenu();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });

    expect(sheet.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expectSameElement(document.activeElement, toggle);
    expect(document.body.style.overflow).toBe("");
  });

  test("widening to the desktop layout closes the sheet and releases the scroll", () => {
    render(<MarketingNav />);
    const { sheet } = openMenu();
    act(() => {
      for (const fn of desktop.listeners) fn({ matches: true });
    });
    expect(sheet.hidden).toBe(true);
    expect(document.body.style.overflow).toBe("");
  });

  test("unmounting with the sheet open releases the scroll", () => {
    const { unmount } = render(<MarketingNav />);
    openMenu();
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("navigation grouping", () => {
  test("the primary navigation follows the visitor's questions, with Developers grouped", () => {
    render(<MarketingNav />);
    const nav = screen.getByRole("navigation", { name: "Main" });
    const desktop = nav.querySelector(".lg\\:flex") as HTMLElement;
    const names = Array.from(desktop.querySelectorAll(":scope > a, :scope > div > button")).map(
      (el) => el.textContent?.replace(" (opens in a new tab)", "")
    );
    expect(names).toEqual(["How it works", "Security", "Guides", "Playground", "Developers"]);
    expect(within(desktop).getByRole("link", { name: "Guides" }).getAttribute("href")).toBe(
      "/content"
    );
  });

  test("Guides is current on the blog", () => {
    spyOn(navigation, "usePathname").mockReturnValue("/blog/some-post");
    render(<MarketingNav />);
    const guides = screen.getAllByRole("link", { name: "Guides" });
    for (const link of guides) expect(link.getAttribute("aria-current")).toBe("page");
  });

  test("Developers opens a disclosure that Escape closes, returning focus", () => {
    render(<MarketingNav />);
    const button = screen.getByRole("button", { name: "Developers" });
    const panel = document.getElementById(
      button.getAttribute("aria-controls") ?? ""
    ) as HTMLElement;
    expect(panel.hidden).toBe(true);

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    const links = within(panel).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/api-keys",
      "https://docs.lumenwipe.com",
      "https://github.com/LumenWipe/lumenwipe",
    ]);

    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: "Escape" });
    expect(panel.hidden).toBe(true);
    expectSameElement(document.activeElement, button);
  });

  test("the footer repeats the groups and reaches the blog in one click", () => {
    render(<MarketingFooter />);
    for (const title of ["Product", "Guides", "Developers", "Open source"]) {
      expect(screen.getByText(title, { selector: "p" })).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: "Blog" }).getAttribute("href")).toBe("/blog");
    expect(screen.getByRole("link", { name: "Guides and videos" }).getAttribute("href")).toBe(
      "/content"
    );
    for (const name of ["API keys", "FAQ", "Stats", "How it works", "Security"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });
});

describe("faq", () => {
  test("a closed answer's link sits in an inert subtree", () => {
    render(<Faq />);
    const first = screen.getByRole("button", { name: "Is LumenWipe really non-custodial?" });
    const panel = document.getElementById(first.getAttribute("aria-controls") ?? "") as HTMLElement;
    const link = within(panel).getByRole("link");
    expect(link.closest("[inert]")).toBeNull();

    fireEvent.click(first);

    expect(link.closest("[inert]")).not.toBeNull();
  });
});

describe("not found", () => {
  test("the page offers the next steps and a way to report the link", () => {
    render(<NotFoundView />);
    const next = screen.getByRole("navigation", { name: "Where to go next" });
    const hrefs = within(next)
      .getAllByRole("link")
      .map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/content", "/how-it-works", "/playground", REPORT_BROKEN_LINK_URL]);
    expect(screen.getByRole("link", { name: /Back to home/ }).getAttribute("href")).toBe("/");
  });

  test("a missing marketing page, such as a blog slug, renders the same view", () => {
    const { container: view } = render(<NotFoundView />);
    const expected = view.innerHTML;
    cleanup();
    const { container } = render(<MarketingNotFound />);
    expect(container.innerHTML).toBe(expected);
  });
});

describe("blog", () => {
  test("the empty state points somewhere useful", () => {
    spyOn(blog, "getAllPostMetas").mockReturnValue([]);
    render(<BlogPage />);
    expect(screen.getByText("No articles published yet.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Watch the videos" }).getAttribute("href")).toBe(
      "/content"
    );
    expect(screen.getByRole("link", { name: "How it works" }).getAttribute("href")).toBe(
      "/how-it-works"
    );
  });
});
