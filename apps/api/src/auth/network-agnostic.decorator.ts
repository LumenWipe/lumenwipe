import { SetMetadata } from "@nestjs/common";

export const IS_NETWORK_AGNOSTIC_KEY = "isNetworkAgnostic";

/**
 * Lets a network-scoped key call a keyed route that has no `:network` param. Without it such a
 * route refuses every scoped key, so a new route cannot widen a key's scope by accident.
 */
export const NetworkAgnostic = () => SetMetadata(IS_NETWORK_AGNOSTIC_KEY, true);
