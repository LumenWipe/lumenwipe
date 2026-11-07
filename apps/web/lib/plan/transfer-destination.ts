import { lookupExchange } from "@/lib/exchange-registry";
import { addressErrorMessage, isValidGAddress } from "@/lib/utils/validation";
import type { AssetDisposition } from "@/types/plan";

/** Why the address cannot receive a transfer, or null. A transfer outside the merge carries no
 *  deposit memo, so an exchange the registry lists could not credit it. */
export function depositAddressMessage(destination: string): string | null {
  const exchange = lookupExchange(destination);
  if (!exchange) return null;
  return `This is a ${exchange.name} deposit address. A transfer in a close carries no deposit memo, so ${exchange.name} could not credit it. Send it to a wallet you control.`;
}

export function transferDestinationError(destination: string): string | null {
  return addressErrorMessage(destination) ?? depositAddressMessage(destination);
}

export function isUsableTransferDestination(destination: string | null | undefined): boolean {
  return !!destination && isValidGAddress(destination) && lookupExchange(destination) === null;
}

/** The first asset whose chosen transfer destination the registry now lists, or null. */
export function refusedTransferAsset(
  dispositions: Record<string, AssetDisposition>,
  destinations: Record<string, string>
): string | null {
  for (const [asset, disposition] of Object.entries(dispositions)) {
    const destination = destinations[asset];
    if (disposition === "transfer" && destination && lookupExchange(destination)) return asset;
  }
  return null;
}

export const TRANSFER_DESTINATION_REFUSED_NOTICE =
  "An account you chose to send an asset to is listed as an exchange deposit address, so the close stopped before its next step and nothing was submitted for it. A transfer in a close carries no deposit memo, so the exchange could not credit it. Choose a wallet you control for that asset below, then confirm again to continue.";

export class TransferDestinationRefusedError extends Error {
  constructor(readonly asset: string) {
    super(TRANSFER_DESTINATION_REFUSED_NOTICE);
    this.name = "TransferDestinationRefusedError";
  }
}
