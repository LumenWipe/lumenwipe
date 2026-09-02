import type { DefiPosition, DefiProtocol } from "@lumenwipe/types";
import type { ExitAdapter } from "./adapter";
import { blendExitAdapter } from "./blend";
import { soroswapExitAdapter } from "./soroswap";

/**
 * The adapters LumenWipe can exit with, by protocol. Adding a protocol is one line here plus its
 * registry entries; the plan, the round builder, the runner, and the client-side verifier all
 * work over the shared interface and never name a protocol.
 *
 * A protocol detection can report but this catalog cannot exit surfaces as a blocker at plan
 * time (`planExitSteps`), never as a position quietly left behind.
 *
 * The plug-in contract an adapter must honor beyond the interface itself: it is run ONCE per
 * (protocol, contract) target, handed the first position it supports, and is expected to plan the
 * whole position at that contract from it (a Blend pool exits as one unit; an LP pair has one
 * balance); and it must report a position that no longer exists with `EXIT_POSITION_GONE`, the
 * one code the round builder reads as "done here" rather than "refuse".
 */
export type AnyExitAdapter = ExitAdapter<DefiPosition, unknown>;

const ADAPTERS: Partial<Record<DefiProtocol, AnyExitAdapter>> = {
  // The interface is generic over the position and live-state types each adapter narrows; the
  // catalog erases them because a caller only ever has a DefiPosition in hand.
  blend: blendExitAdapter() as AnyExitAdapter,
  soroswap: soroswapExitAdapter() as AnyExitAdapter,
};

export function exitAdapterFor(protocol: DefiProtocol): AnyExitAdapter | null {
  return ADAPTERS[protocol] ?? null;
}
