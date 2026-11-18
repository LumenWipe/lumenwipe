import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_GENERATOR_VERSION, MAX_SEED, parseReplayCode } from "@/lib/scenarios";
import { dateReplayCode, nightlySeed, SEED_ENV } from "../../scripts/nightly-seed";

const CLI = join(import.meta.dir, "..", "..", "scripts", "choose-nightly-seed.ts");

describe("dateReplayCode", () => {
  test("is frozen per UTC day, so a logged code still names the night it ran", () => {
    expect(dateReplayCode(new Date("2026-11-19T12:00:00Z"))).toBe("LW1-HXXDDGGN");
    expect(dateReplayCode(new Date("2026-11-20T12:00:00Z"))).toBe("LW1-EMRF0SW2");
  });

  test("is the same all day in UTC and changes at UTC midnight, whatever the local zone", () => {
    const zone = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      const day = dateReplayCode(new Date("2026-11-19T00:00:00Z"));
      expect(dateReplayCode(new Date("2026-11-19T23:59:59.999Z"))).toBe(day);
      expect(dateReplayCode(new Date("2026-11-18T19:30:00-05:00"))).toBe(day);
      expect(dateReplayCode(new Date("2026-11-19T19:30:00-05:00"))).not.toBe(day);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  test("reads back with the current generator and reaches the seed's high bits", () => {
    const seeds = Array.from({ length: 60 }, (_, i) => {
      const parsed = parseReplayCode(dateReplayCode(new Date(Date.UTC(2026, 0, 1 + i))));
      expect(parsed?.version).toBe(CURRENT_GENERATOR_VERSION);
      return parsed!.seed;
    });
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const seed of seeds) expect(seed).toBeLessThanOrEqual(MAX_SEED);
    expect(seeds.some((seed) => seed >= 2 ** 32)).toBe(true);
  });
});

describe("nightlySeed", () => {
  const date = new Date("2026-11-19T07:00:00Z");

  test("runs the day's code when no override is given", () => {
    const day = { code: "LW1-HXXDDGGN", version: 1 };
    expect(nightlySeed(date, undefined)).toEqual(day);
    expect(nightlySeed(date, "")).toEqual(day);
  });

  test("runs a manual run's code, normalized the way the replay box reads it", () => {
    expect(nightlySeed(date, "LW1-J94RHBTC")).toEqual({ code: "LW1-J94RHBTC", version: 1 });
    expect(nightlySeed(date, " lw1-j94rhbtc ")).toEqual({ code: "LW1-J94RHBTC", version: 1 });
  });

  test.each([
    "   ",
    "LW1-J94RHBT",
    "LW1-J94RHBTCX",
    "LW9-J94RHBTC",
    "LW1-J94RHBTU",
    "1; echo pwned",
    "$(id)",
  ])("refuses %p without repeating it", (override) => {
    expect(() => nightlySeed(date, override)).toThrow(`${SEED_ENV} is not a replay code`);
    try {
      nightlySeed(date, override);
    } catch (err) {
      expect((err as Error).message).not.toContain(override.trim() || "\u0000");
    }
  });
});

describe("choose-nightly-seed", () => {
  const run = (seed: string | undefined, output: string) =>
    Bun.spawnSync([process.execPath, CLI], {
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: output, [SEED_ENV]: seed ?? "" },
    });

  test("logs the code as a notice and hands it to later steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "lw-nightly-seed-"));
    try {
      const output = join(dir, "output");
      const result = run("lw1-j94rhbtc", output);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(
        "::notice title=Random wallet::Replay code LW1-J94RHBTC, generator v1\n"
      );
      expect(readFileSync(output, "utf8")).toBe("code=LW1-J94RHBTC\nversion=1\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails before writing anything when the override is not a replay code", () => {
    const dir = mkdtempSync(join(tmpdir(), "lw-nightly-seed-"));
    try {
      const output = join(dir, "output");
      const result = run("x\ncode=LW1-AAAAAAAA", output);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(() => readFileSync(output, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
