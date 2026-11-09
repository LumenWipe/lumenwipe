import { SCENARIOS } from "./definitions";
import { fitSelection } from "./presets";
import { parseSelection, validateSelection, type ValidateOptions } from "./resolve";
import type { ScenarioDefinition, ScenarioId, ScenarioSelection } from "./types";

// A random wallet that can be replayed exactly from its code ("LW1-7Q2M4KD9"). The generator is a
// pure function of the seed, the generator version and which scenarios this deployment can run:
// no clock, no global randomness, no floating point. Every step is 32-bit integer arithmetic that
// ECMAScript defines exactly, so a seed gives the same wallet in the browser and on the server.
// The seed only chooses scenarios and their settings; key pairs never come from it.

export const CURRENT_GENERATOR_VERSION = 1;

/** Eight Crockford base32 characters: 40 bits. */
const CODE_LENGTH = 8;
export const MAX_SEED = 2 ** (5 * CODE_LENGTH) - 1;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UINT32 = 2 ** 32;

function splitmix32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** sfc32, its state seeded by splitmix32 from the seed's low 32 bits and its high 8 bits. */
export class SeededRandom {
  private a: number;
  private b: number;
  private c: number;
  private d = 1;

  constructor(seed: number) {
    const low = splitmix32(seed % UINT32);
    const high = splitmix32(Math.floor(seed / UINT32) ^ 0x5bd1e995);
    this.a = low();
    this.b = low();
    this.c = high();
    for (let i = 0; i < 15; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** A uniform integer in [0, n), by rejection so no value is favoured. */
  nextInt(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > UINT32)
      throw new RangeError("nextInt needs 1 to 2^32");
    const limit = UINT32 - (UINT32 % n);
    for (;;) {
      const x = this.nextUint32();
      if (x < limit) return x % n;
    }
  }

  /** One item, chosen with probability proportional to its positive integer weight. */
  pick<T>(items: readonly T[], weight: (item: T) => number): T {
    let r = this.nextInt(items.reduce((sum, item) => sum + weight(item), 0));
    const last = items.length - 1;
    for (const item of items.slice(0, last)) {
      r -= weight(item);
      if (r < 0) return item;
    }
    return items[last];
  }
}

/** The code for a known seed (a replayed code, a vector, a test); fresh codes come from newReplayCode. */
export function formatReplayCode(seed: number, version = CURRENT_GENERATOR_VERSION): string {
  let body = "";
  let rest = seed;
  for (let i = 0; i < CODE_LENGTH; i++) {
    body = CROCKFORD.charAt(rest % 32) + body;
    rest = Math.floor(rest / 32);
  }
  return `LW${version}-${body}`;
}

/** Crockford's reading of a character: case-insensitive, I and L as 1, O as 0; -1 if invalid. */
function crockfordValue(char: string): number {
  const upper = char.toUpperCase();
  if (upper === "I" || upper === "L") return 1;
  if (upper === "O") return 0;
  return CROCKFORD.indexOf(upper);
}

/** Reads a replay code; null for anything that is not one, including an unknown version. */
export function parseReplayCode(text: string): { version: number; seed: number } | null {
  const code = text.trim();
  if (code.length > 16 || code.slice(0, 2).toUpperCase() !== "LW") return null;
  const dash = code.indexOf("-");
  const versionText = code.slice(2, dash);
  const body = code.slice(dash + 1);
  if (body.length !== CODE_LENGTH) return null;
  if ([...versionText].some((ch) => ch < "0" || ch > "9")) return null;
  const version = Number(versionText);
  if (!(version in GENERATORS)) return null;
  let seed = 0;
  for (const char of body) {
    const value = crockfordValue(char);
    if (value < 0) return null;
    seed = seed * 32 + value;
  }
  return { version, seed };
}

/**
 * A fresh replay code from the platform's cryptographic source. Each random byte picks one of the
 * 32 Crockford characters by its low five bits, which is unbiased because 256 is a multiple of 32;
 * the seed is read back from the code with parseReplayCode.
 */
export function newReplayCode(): string {
  let body = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
    body += CROCKFORD.charAt(byte & 31);
  }
  return `LW${CURRENT_GENERATOR_VERSION}-${body}`;
}

type Generator = (seed: number, options: ValidateOptions) => ScenarioSelection;

/** How many scenarios a wallet starts with, by weight. */
const COUNT_WEIGHTS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 4],
  [3, 5],
  [4, 4],
  [5, 3],
  [6, 2],
];

/**
 * The scenarios version 1 draws from, with their weights. Frozen with the generator: a scenario
 * added to the registry later is not drawn by v1, so every v1 code keeps naming the same wallet.
 */
const V1_SCENARIO_WEIGHTS: ReadonlyMap<ScenarioId, number> = new Map<ScenarioId, number>([
  ["lwdemo-holding", 4],
  ["junk-airdrops", 4],
  ["stablecoin-swaps", 3],
  ["data-entries", 4],
  ["stale-offers", 4],
  ["forgotten-signer", 3],
]);

/** The scenarios a v1 wallet can contain. */
export const V1_SCENARIO_IDS: readonly ScenarioId[] = [...V1_SCENARIO_WEIGHTS.keys()];

const weightOf = (def: ScenarioDefinition): number => V1_SCENARIO_WEIGHTS.get(def.id) ?? 0;

const generateV1: Generator = (seed, options) => {
  const random = new SeededRandom(seed);
  const unavailable = options.unavailable ?? new Map<ScenarioId, string>();
  // Only scenarios that can run here and whose requirement something here can meet.
  const runnable = SCENARIOS.filter((s) => V1_SCENARIO_WEIGHTS.has(s.id) && !unavailable.has(s.id));
  const providersOf = (def: ScenarioDefinition): ScenarioDefinition[] =>
    runnable.filter((s) => def.requiresAnyOf.includes(s.id));
  const eligible = runnable.filter(
    (s) => s.requiresAnyOf.length === 0 || providersOf(s).length > 0
  );
  let pool = eligible;
  const count = random.pick(COUNT_WEIGHTS, ([, w]) => w)[0];

  const picked: ScenarioDefinition[] = [];
  while (picked.length < count && pool.length > 0) {
    const def = random.pick(pool, weightOf);
    pool = pool.filter((s) => s !== def);
    const clashes = picked.some(
      (p) => p.conflicts.includes(def.id) || def.conflicts.includes(p.id)
    );
    if (!clashes) picked.push(def);
  }

  for (let i = 0; i < picked.length; i++) {
    const def = picked[i];
    if (def.requiresAnyOf.length === 0) continue;
    if (picked.some((p) => def.requiresAnyOf.includes(p.id))) continue;
    picked.push(random.pick(providersOf(def), weightOf));
  }

  const scenarios = picked.map((def) => ({
    id: def.id,
    params: Object.fromEntries(
      Object.entries(def.params).map(([name, spec]) => [
        name,
        spec.min + random.nextInt(spec.max - spec.min + 1),
      ])
    ),
  }));
  return fitSelection({ scenarios }, options);
};

/** Each version's generator, frozen once released: a change of behavior is a new version. */
export const GENERATORS: Readonly<Record<number, Generator>> = { 1: generateV1 };

/**
 * The wallet a seed stands for: a selection that passes the validator for these options, or null
 * for an unknown version or a deployment that can run nothing.
 */
export function generateRandomSelection(
  seed: number,
  options: ValidateOptions & { version?: number } = {}
): ScenarioSelection | null {
  const generator = GENERATORS[options.version ?? CURRENT_GENERATOR_VERSION];
  if (!generator || !Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) return null;
  const selection = generator(seed, options);
  return validateSelection(selection, options).ok ? selection : null;
}

/** Longest `selection` link parameter read; a real selection encodes to a few hundred characters. */
export const MAX_ENCODED_SELECTION = 2048;

/** A selection as a URL-safe string that replays without any generator. */
export function encodeSelection(selection: ScenarioSelection): string {
  const base64 = btoa(JSON.stringify(selection));
  let out = "";
  for (const ch of base64) {
    if (ch === "+") out += "-";
    else if (ch === "/") out += "_";
    else if (ch !== "=") out += ch;
  }
  return out;
}

/** Reads an encoded selection from a link; null for anything too long or malformed. atob accepts
 *  base64 without its padding, which the link leaves out. */
export function decodeSelection(text: string): ScenarioSelection | null {
  if (text.length > MAX_ENCODED_SELECTION) return null;
  // atob refuses anything outside the base64 alphabet, so only the two URL-safe digits need mapping.
  const base64 = text.split("-").join("+").split("_").join("/");
  try {
    return parseSelection(JSON.parse(atob(base64)));
  } catch {
    return null;
  }
}
