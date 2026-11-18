import { formatReplayCode, parseReplayCode, SeededRandom } from "../lib/scenarios/random";

// The nightly's random wallet: one replay code per UTC day, so every run on the same day draws the
// same wallet and a failure can be replayed from the code alone. A manual run can name its own.

/** Where a manual run's replay code arrives; empty or unset means the day's code. */
export const SEED_ENV = "LUMENWIPE_SEED";

/** The UTC calendar day as a number (2026-11-19 is 20261119). */
const utcDay = (date: Date): number =>
  date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();

/** The day's replay code: 40 bits drawn from a generator seeded by the UTC date. */
export function dateReplayCode(date: Date): string {
  const random = new SeededRandom(utcDay(date));
  return formatReplayCode(random.nextInt(2 ** 8) * 2 ** 32 + random.nextUint32());
}

/** The code tonight's random wallet runs, normalized, and its generator version. Throws when the
 *  override is not a replay code this generator can read, without repeating it. */
export function nightlySeed(
  date: Date,
  override: string | undefined
): { code: string; version: number } {
  const parsed = parseReplayCode(override ? override : dateReplayCode(date));
  if (!parsed)
    throw new Error(
      `${SEED_ENV} is not a replay code (LW, the generator version, a dash, 8 characters)`
    );
  return { code: formatReplayCode(parsed.seed, parsed.version), version: parsed.version };
}
