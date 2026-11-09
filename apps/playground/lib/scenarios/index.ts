// The playground's scenario registry: one declarative definition per kind of mess, from which the
// plan, the executor's steps, the verifier's expectation, the cost model and the scene are derived.
// Isomorphic: no server-only code, no Stellar SDK, no I/O.
export * from "./caps";
export * from "./catalog";
export { SCENARIOS } from "./definitions";
export * from "./presets";
export * from "./resolve";
export * from "./types";
