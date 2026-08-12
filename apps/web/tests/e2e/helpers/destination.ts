import { expect, type Page } from "@playwright/test";

/**
 * Ticks the "this is a wallet I control" confirmation that appears for a destination the
 * bundled exchange registry does not recognize (issue #115).
 *
 * Every spec's `Keypair.random()` destination is unrecognized by definition, so the
 * confirmation is expected, not merely tolerated. Asserting it is visible rather than probing
 * with a bare `isVisible()` matters twice over: `isVisible()` does not auto-wait, so called
 * right after `.fill()` it races the re-render that creates the checkbox; and a silent no-op
 * would let a copy change to the label, or the control vanishing entirely, surface as a
 * confusing failure on some later assertion - or, where the next assertion happens to expect a
 * disabled button, as no failure at all.
 *
 * Do not call this for a registry exchange address: no confirmation is offered there, and the
 * absence is the assertion worth making at that call site.
 */
export async function confirmDestinationControl(page: Page): Promise<void> {
  const checkbox = page.getByRole("checkbox", {
    name: /wallet I control, not an exchange or custodial account/i,
  });
  await expect(checkbox).toBeVisible({ timeout: 15_000 });
  await checkbox.check();
}
