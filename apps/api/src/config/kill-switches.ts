import type { DefiProtocol } from "@lumenwipe/types";
import { getMediatorPublicKey, type Network } from "@/config/networks";
import { getMediatorKeypair } from "@/lib/stellar/mediator-server";
import { isConversionEnabled } from "@/lib/soroswap/conversion-quotes";
import { isXBullEnabled } from "@/lib/xbull/conversion-quotes";

/**
 * Paths an operator can turn off with a revision environment update, no code deploy. Read once
 * per request and handed to the plan and the builder as state: neither reads the environment.
 */
export interface KillSwitches {
  feeSponsorship: boolean;
  mediatorForward: boolean;
  /** Whether the relay account's key is set for the network, so its forward can be co-signed. */
  mediatorConfigured: boolean;
  sorobanConversion: boolean;
  xbullConversion: boolean;
  pausedExits: ReadonlySet<DefiProtocol>;
}

export const FEE_SPONSORSHIP_FLAG = "FEE_SPONSORSHIP_ENABLED";
export const MEDIATOR_FORWARD_FLAG = "MEDIATOR_FORWARD_ENABLED";

export const EXIT_FLAGS: ReadonlyArray<{ protocol: DefiProtocol; name: string }> = [
  { protocol: "aquarius", name: "AQUARIUS_EXIT_ENABLED" },
  { protocol: "blend", name: "BLEND_EXIT_ENABLED" },
  { protocol: "fxdao", name: "FXDAO_EXIT_ENABLED" },
  { protocol: "phoenix", name: "PHOENIX_EXIT_ENABLED" },
  { protocol: "soroswap", name: "SOROSWAP_EXIT_ENABLED" },
];

/** Every switch that is on unless set to false, with what turning it off pauses. */
export const ON_UNLESS_FALSE_FLAGS: ReadonlyArray<{ name: string; pauses: string }> = [
  { name: FEE_SPONSORSHIP_FLAG, pauses: "sponsored-fee closes are paused" },
  { name: MEDIATOR_FORWARD_FLAG, pauses: "exchange closes through the relay account are paused" },
  ...EXIT_FLAGS.map(({ protocol, name }) => ({ name, pauses: `${protocol} exits are paused` })),
];

export const ALL_ON: KillSwitches = {
  feeSponsorship: true,
  mediatorForward: true,
  mediatorConfigured: true,
  sorobanConversion: true,
  xbullConversion: true,
  pausedExits: new Set(),
};

/** Unset or empty is on, so a missing variable never turns a path off. */
export function flagOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "false";
}

/** Set to something other than true or false: refused at startup rather than guessed at. */
export function isMalformedFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "true" && normalized !== "false";
}

function relayKeyConfigured(network: Network): boolean {
  try {
    return getMediatorPublicKey(network) !== "" && getMediatorKeypair(network) !== null;
  } catch {
    return false;
  }
}

export function readKillSwitches(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
  mediatorConfigured: (network: Network) => boolean = relayKeyConfigured
): KillSwitches {
  return {
    feeSponsorship: flagOn(env[FEE_SPONSORSHIP_FLAG]),
    mediatorForward: flagOn(env[MEDIATOR_FORWARD_FLAG]),
    mediatorConfigured: mediatorConfigured(network),
    sorobanConversion: isConversionEnabled({
      enabled: env.SOROBAN_CONVERSION_ENABLED === "true",
      apiKey: env.SOROSWAP_API_KEY?.trim() || undefined,
      baseUrl: undefined,
    }),
    xbullConversion: isXBullEnabled({ enabled: env.XBULL_CONVERSION_ENABLED === "true" }),
    pausedExits: new Set(
      EXIT_FLAGS.filter(({ name }) => !flagOn(env[name])).map(({ protocol }) => protocol)
    ),
  };
}
