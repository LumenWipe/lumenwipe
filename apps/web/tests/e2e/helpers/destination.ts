import { type Page } from "@playwright/test";

/**
 * Ticks the "this is a wallet I control" confirmation that appears for a destination the
 * bundled exchange registry does not recognize (issue #115).
 *
 * Every specs' `Keypair.random()` destination is unrecognized by definition, so this step
 * gates "Begin execution" in all of them. It is a no-op for a registry exchange address,
 * where no confirmation is shown - so specs can call it unconditionally after filling the
 * destination without knowing which kind they used.
 */
export async function confirmDestinationControl(page: Page): Promise<void> {
  const checkbox = page.getByRole("checkbox", {
    name: /wallet I control, not an exchange or custodial account/i,
  });
  if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.check();
  }
}
