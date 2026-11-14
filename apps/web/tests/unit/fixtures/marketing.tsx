import { spyOn } from "bun:test";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import * as navigation from "next/navigation";

/** Renders a marketing page or component and returns its root, with the router stubbed for the
 *  hero analyzer. */
export function renderMarketing(element: ReactElement): HTMLElement {
  spyOn(navigation, "useRouter").mockReturnValue({
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  } as unknown as ReturnType<typeof navigation.useRouter>);
  spyOn(navigation, "usePathname").mockReturnValue("/");
  return render(element).container;
}

/** The root's text with every element carrying an explicit status label left out. */
export function textOutsideStatusLabels(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-site-status]").forEach((el) => el.remove());
  return copy.textContent ?? "";
}
