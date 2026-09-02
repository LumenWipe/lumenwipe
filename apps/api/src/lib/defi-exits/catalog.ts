import type { DefiPosition, DefiProtocol } from "@lumenwipe/types";
import type { ExitAdapter } from "./adapter";
import { blendExitAdapter } from "./blend";

/**
 * The adapters LumenWipe can exit with, by protocol. Adding a protocol is one line here plus its
 * registry entries; the plan, the round builder, the runner, and the client-side verifier all
 * work over the shared interface and never name a protocol.
 *
 * A protocol detection can report but this catalog cannot exit surfaces as a blocker at plan
 * time (`planExitSteps`), never as a position quietly left behind.
 */
export type AnyExitAdapter = ExitAdapter<DefiPosition, unknown>;

const ADAPTERS: Partial<Record<DefiProtocol, AnyExitAdapter>> = {
  // The interface is generic over the position and live-state types each adapter narrows; the
  // catalog erases them because a caller only ever has a DefiPosition in hand.
  blend: blendExitAdapter() as AnyExitAdapter,
};

export function exitAdapterFor(protocol: DefiProtocol): AnyExitAdapter | null {
  return ADAPTERS[protocol] ?? null;
}
