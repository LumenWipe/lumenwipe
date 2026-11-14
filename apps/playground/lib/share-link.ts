import { encodeSelection, type ScenarioSelection } from "./scenarios";

type Location = Pick<URL, "origin" | "pathname">;

/** A link that opens the playground on this exact selection; it names no session or account. */
export function selectionLink(location: Location, selection: ScenarioSelection): string {
  return `${location.origin}${location.pathname}?selection=${encodeSelection(selection)}`;
}

/** A link that opens the playground on a batch of this size, the whole of what a batch shares. */
export function batchLink(location: Location, size: 2 | 3): string {
  return `${location.origin}${location.pathname}?batch=${size}`;
}
