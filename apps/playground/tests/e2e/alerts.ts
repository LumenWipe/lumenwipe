import type { Locator, Page } from "@playwright/test";

/** The page's own alerts. Next's app router mounts an empty `role="alert"` live region inside
 *  `<next-route-announcer>`'s open shadow root on every page, and Playwright pierces it, so a bare
 *  `getByRole("alert")` always counts one. Only that announcer is left out. */
export function appAlerts(page: Page): Locator {
  return page.locator('[role="alert"]:not(next-route-announcer *)');
}
