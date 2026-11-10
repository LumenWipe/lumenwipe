import { describe, expect, spyOn, test } from "bun:test";
import {
  CURRENT_GENERATOR_VERSION,
  GENERATORS,
  MAX_ENCODED_SELECTION,
  MAX_SCENARIOS,
  MAX_SEED,
  SCENARIOS,
  SeededRandom,
  V1_SCENARIO_IDS,
  decodeSelection,
  encodeSelection,
  formatReplayCode,
  generateRandomSelection,
  newReplayCode,
  parseReplayCode,
  resolvePlan,
  validateSelection,
  type ScenarioId,
  type ScenarioSelection,
} from "@/lib/scenarios";
import vectorFile from "../fixtures/random-v1-vectors.json";

/** Returns the given draws in order once constructed, so a test controls what the PRNG says. */
class Scripted extends SeededRandom {
  private script: number[] | undefined;

  constructor(draws: number[]) {
    super(0);
    this.script = [...draws];
  }

  override nextUint32(): number {
    return this.script ? (this.script.shift() ?? 0) : super.nextUint32();
  }
}

/** Seeds spread over the whole 40-bit range, the same on every run. */
const seedAt = (i: number): number => (i * 2_654_435_761) % (MAX_SEED + 1);

function generate(seed: number, unavailable = new Map<ScenarioId, string>()): ScenarioSelection {
  const selection = generateRandomSelection(seed, { unavailable });
  if (!selection) throw new Error(`seed ${seed} produced no selection`);
  return selection;
}

describe("determinism", () => {
  test("the same seed and version give byte-identical selection JSON, over 10,000 seeds", () => {
    let differFromNext = 0;
    let previous = "";
    for (let i = 0; i < 10_000; i++) {
      const json = JSON.stringify(generate(seedAt(i)));
      expect(JSON.stringify(generate(seedAt(i)))).toBe(json);
      if (json !== previous) differFromNext++;
      previous = json;
    }
    // Distinct seeds mostly give distinct wallets; the space of wallets is finite, so not all do.
    expect(differFromNext).toBeGreaterThan(9_800);
  });

  test("frozen v1 vectors: a silent change of behavior fails here", () => {
    expect(vectorFile.generatorVersion).toBe(1);
    expect(vectorFile.vectors).toHaveLength(64);
    for (const { code, seed, selection } of vectorFile.vectors) {
      expect(formatReplayCode(seed, 1)).toBe(code);
      expect(parseReplayCode(code)).toEqual({ version: 1, seed });
      expect(JSON.stringify(generateRandomSelection(seed, { version: 1 }))).toBe(
        JSON.stringify(selection)
      );
    }
  });

  test("the PRNG output is frozen, the same in every runtime", () => {
    // Computed with Bun (JavaScriptCore) and checked with Node (V8): integer-only arithmetic.
    const first = (seed: number): number[] => {
      const random = new SeededRandom(seed);
      return [random.nextUint32(), random.nextUint32(), random.nextUint32()];
    };
    expect(first(0)).toEqual([3117971542, 3686119160, 360115792]);
    expect(first(1)).toEqual([182843213, 3484141105, 2765029810]);
    expect(first(MAX_SEED)).toEqual([3190922164, 1601441507, 1298324208]);
    const ints = new SeededRandom(42);
    expect(Array.from({ length: 8 }, () => ints.nextInt(6))).toEqual([5, 0, 5, 1, 3, 2, 3, 1]);
  });

  test("an integer draw stays in range, and an empty range or list is refused", () => {
    const random = new SeededRandom(9);
    for (let i = 0; i < 1_000; i++) {
      const n = random.nextInt(7);
      expect(Number.isInteger(n) && n >= 0 && n < 7).toBe(true);
    }
    expect(random.nextInt(1)).toBe(0);
    expect(() => random.pick([], () => 1)).toThrow("nextInt needs 1 to 2^32");
    for (const bad of [0, -1, 1.5, 2 ** 32 + 1]) {
      expect(() => random.nextInt(bad)).toThrow("nextInt needs 1 to 2^32");
    }
    expect(random.nextInt(2 ** 32)).toBeLessThan(2 ** 32);
    expect(random.pick(["only"], () => 3)).toBe("only");
  });

  test("a draw at or above the largest multiple of n is rejected, so no value is favoured", () => {
    // 2^32 % 3 = 1, so 2^32 - 1 is the first value that would favour 0, and is drawn again.
    const random = new Scripted([2 ** 32 - 1, 2 ** 32 - 2, 5]);
    expect(random.nextInt(3)).toBe((2 ** 32 - 2) % 3);
    expect(random.nextInt(3)).toBe(2);
  });

  test("a weighted pick follows the weights", () => {
    const weights: Record<string, number> = { a: 1, b: 3, c: 2 };
    const picks = [0, 1, 3, 4, 5].map((r) =>
      new Scripted([r]).pick(["a", "b", "c"], (i) => weights[i] ?? 0)
    );
    expect(picks).toEqual(["a", "b", "b", "c", "c"]);
  });

  test("every released version keeps its generator", () => {
    expect(CURRENT_GENERATOR_VERSION).toBe(1);
    expect(Object.keys(GENERATORS)).toEqual(["1"]);
    expect(generateRandomSelection(1, { version: 2 })).toBeNull();
  });
});

describe("properties over 5,000 seeds", () => {
  test("every wallet is valid, complete and ordered", () => {
    for (let i = 0; i < 5_000; i++) {
      const selection = generate(seedAt(i));
      const ids = selection.scenarios.map((c) => c.id);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(ids.length).toBeLessThanOrEqual(MAX_SCENARIOS);
      // Within every cap, with every parameter in range: the validator checks both.
      expect(validateSelection(selection).ok).toBe(true);

      const defs = SCENARIOS.filter((s) => ids.includes(s.id));
      for (const def of defs) {
        if (def.requiresAnyOf.length > 0) {
          expect(def.requiresAnyOf.some((r) => ids.includes(r))).toBe(true);
        }
        for (const other of def.conflicts) expect(ids).not.toContain(other);
      }

      const plan = resolvePlan(selection);
      const stepIds = plan.steps.map((s) => s.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
      if (stepIds.includes("ADD_SIGNER")) expect(stepIds[stepIds.length - 1]).toBe("ADD_SIGNER");

      const trusted = new Set<string>(["native"]);
      for (const step of plan.steps) {
        if (step.action.kind === "change_trust") trusted.add(step.action.asset);
        if (step.action.kind === "offers") {
          for (const offer of step.action.offers) {
            expect(trusted.has(offer.selling) && trusted.has(offer.buying)).toBe(true);
          }
        }
      }
      expect(JSON.stringify(resolvePlan(JSON.parse(JSON.stringify(selection))))).toBe(
        JSON.stringify(plan)
      );
    }
  });

  test("a scenario switched off here is never drawn", () => {
    const unavailable = new Map<ScenarioId, string>([
      ["lwdemo-holding", "off"],
      ["junk-airdrops", "off"],
    ]);
    for (let i = 0; i < 2_000; i++) {
      const ids = generate(seedAt(i), unavailable).scenarios.map((c) => c.id);
      expect(ids).not.toContain("lwdemo-holding");
      expect(ids).not.toContain("junk-airdrops");
    }
  });

  test("a scenario whose every provider is switched off is dropped, not left unmet", () => {
    const unavailable = new Map<ScenarioId, string>([
      ["lwdemo-holding", "off"],
      ["junk-airdrops", "off"],
      ["stablecoin-swaps", "off"],
    ]);
    for (let i = 0; i < 2_000; i++) {
      const ids = generate(seedAt(i), unavailable).scenarios.map((c) => c.id);
      expect(ids).not.toContain("stale-offers");
    }
  });

  test("when nothing can run there is no wallet", () => {
    const all = new Map(SCENARIOS.map((s) => [s.id, "off"]));
    expect(generateRandomSelection(7, { unavailable: all })).toBeNull();
  });
});

test("v1 draws from the six scenarios it shipped with, so a later scenario never changes a code", () => {
  expect(V1_SCENARIO_IDS).toEqual([
    "lwdemo-holding",
    "junk-airdrops",
    "stablecoin-swaps",
    "data-entries",
    "stale-offers",
    "forgotten-signer",
  ]);
  const later = SCENARIOS.map((s) => s.id).filter((id) => !V1_SCENARIO_IDS.includes(id));
  expect(later).toEqual([
    "dispositions",
    "claimable-balances",
    "sponsored-reserves",
    "multisig",
    "soroswap-lp",
    "aquarius-lp",
    "blend-supply",
    "phoenix-lp",
    "allowances",
    "fee-bump",
  ]);
  for (let i = 0; i < 20_000; i++) {
    for (const { id } of generate(seedAt(i)).scenarios) expect(later).not.toContain(id);
  }
});

test("coverage over 20,000 seeds: every v1 scenario appears, none always", () => {
  const counts = new Map<ScenarioId, number>(V1_SCENARIO_IDS.map((id) => [id, 0]));
  const runs = 20_000;
  for (let i = 0; i < runs; i++) {
    for (const { id } of generate(seedAt(i)).scenarios) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    expect({ id, drawn: n > 0, always: n === runs }).toEqual({ id, drawn: true, always: false });
  }
});

describe("replay codes", () => {
  test("format and parse round-trip across the range", () => {
    for (const seed of [0, 1, 31, 32, MAX_SEED, seedAt(12345)]) {
      const code = formatReplayCode(seed);
      expect(code).toMatch(/^LW1-[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(parseReplayCode(code)).toEqual({ version: 1, seed });
    }
    expect(formatReplayCode(MAX_SEED)).toBe("LW1-ZZZZZZZZ");
    expect(formatReplayCode(33)).toBe("LW1-00000011");
  });

  test("reading is forgiving the way Crockford base32 is", () => {
    const seed = parseReplayCode("LW1-0000001Z")!.seed;
    expect(parseReplayCode("  lw1-0000001z ")).toEqual({ version: 1, seed });
    expect(parseReplayCode("LW1-OOOOOOIZ")).toEqual({ version: 1, seed });
    expect(parseReplayCode("LW1-0000000L")).toEqual({ version: 1, seed: 1 });
  });

  test("a version is read as digits only, leading zeros included", () => {
    expect(parseReplayCode("LW00001-J94RHBTC")).toEqual(parseReplayCode("LW1-J94RHBTC"));
    for (const bad of ["LW1.0-J94RHBTC", "LW+1-J94RHBTC", "LW1e0-J94RHBTC", "LW 1-J94RHBTC"]) {
      expect({ bad, parsed: parseReplayCode(bad) }).toEqual({ bad, parsed: null });
    }
    expect(parseReplayCode("LW000000000001-J94RHBTC")).toBeNull();
  });

  test("anything else is refused", () => {
    for (const bad of [
      "",
      "LW1",
      "LW1-",
      "LW1-0000000",
      "LW1-000000000",
      "LW1-0000000U",
      "LW1-0000000!",
      "LW2-00000000",
      "LWX-00000000",
      "LW-00000000",
      "XX1-00000000",
      "LW1 00000000",
      "LW1-0000-000",
      "LW0001-0000000000",
    ]) {
      expect({ bad, parsed: parseReplayCode(bad) }).toEqual({ bad, parsed: null });
    }
  });

  test("the whole range has wallets, both ends included", () => {
    expect(generateRandomSelection(0)).not.toBeNull();
    expect(generateRandomSelection(MAX_SEED)).not.toBeNull();
  });

  test("a seed outside the range has no wallet", () => {
    for (const seed of [-1, MAX_SEED + 1, 1.5, Number.NaN]) {
      expect(generateRandomSelection(seed)).toBeNull();
    }
  });

  test("a fresh code maps each random byte to the Crockford character of its low five bits", () => {
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.set([0, 31, 32, 255, 1, 10, 22, 0xe0]);
        return array;
      }
    );
    try {
      expect(newReplayCode()).toBe("LW1-0Z0Z1AP0");
    } finally {
      spy.mockRestore();
    }
  });

  test("10,000 fresh codes are all valid, in the Crockford alphabet, with 40-bit seeds", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const code = newReplayCode();
      expect(code).toMatch(/^LW1-[0-9A-HJKMNP-TV-Z]{8}$/);
      const parsed = parseReplayCode(code);
      expect(parsed?.version).toBe(1);
      const seed = parsed?.seed ?? -1;
      expect(Number.isSafeInteger(seed) && seed >= 0 && seed < 2 ** 40).toBe(true);
      expect(formatReplayCode(seed)).toBe(code);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(9_990);
  });
});

describe("exact selection links", () => {
  test("a selection round-trips through its link text", () => {
    for (let i = 0; i < 200; i++) {
      const selection = generate(seedAt(i));
      const text = encodeSelection(selection);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeSelection(text)).toEqual(selection);
    }
  });

  test("base64's + and / travel as - and _", () => {
    // "~" and "?" are what put a 62 or a 63 into a base64 digit.
    for (const name of ["~~~>>>", "???"]) {
      const selection = { scenarios: [{ id: "data-entries" as const, params: { [name]: 1 } }] };
      const plain = btoa(JSON.stringify(selection));
      const text = encodeSelection(selection);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(text).toBe(plain.split("+").join("-").split("/").join("_").split("=").join(""));
      expect(decodeSelection(text)).toEqual(selection);
    }
    expect(btoa(JSON.stringify({ k: "~~~>>>" }))).toContain("+");
    expect(btoa(JSON.stringify({ k: "???" }))).toContain("/");
  });

  test(`a link up to ${MAX_ENCODED_SELECTION} characters is read, one longer is not`, () => {
    const encodedWith = (nameLength: number) => {
      const selection = {
        scenarios: [{ id: "data-entries" as const, params: { ["x".repeat(nameLength)]: 1 } }],
      };
      return { selection, text: encodeSelection(selection) };
    };
    let length = 0;
    while (encodedWith(length).text.length < MAX_ENCODED_SELECTION) length++;
    const atLimit = encodedWith(length);
    expect(atLimit.text.length).toBe(MAX_ENCODED_SELECTION);
    expect(decodeSelection(atLimit.text)).toEqual(atLimit.selection);
    const over = encodedWith(length + 1);
    expect(over.text.length).toBeGreaterThan(MAX_ENCODED_SELECTION);
    expect(decodeSelection(over.text)).toBeNull();
  });

  test("text that is too long, not base64url, not JSON or not a selection is refused", () => {
    const valid = encodeSelection(generate(1));
    for (const bad of [
      "",
      "a".repeat(MAX_ENCODED_SELECTION + 1),
      `${valid}=`,
      `${valid}+`,
      "%%%",
      btoa("not json"),
      encodeSelection({ scenarios: [] }).slice(0, 3),
      btoa(JSON.stringify({ scenarios: [{ id: "drop-table" }] })),
    ]) {
      expect({ bad, decoded: decodeSelection(bad) }).toEqual({ bad, decoded: null });
    }
    // Well-formed but empty: it decodes, and the validator refuses it when the run starts.
    expect(decodeSelection(encodeSelection({ scenarios: [] }))).toEqual({ scenarios: [] });
  });
});
