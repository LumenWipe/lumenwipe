/**
 * Protocol rewards accrue for every second a position exists, so a claim always leaves a fresh,
 * tiny reward behind by the time the next round reads the position again; claiming that too would
 * never end. A reward worth less than this many seconds of the position's own emissions is what
 * accrued during the close itself: it is not claimed, and the withdrawal that follows leaves it
 * with the protocol. Anything that has been accruing longer is claimed first.
 */
export const REWARD_DUST_WINDOW_SECONDS = 900n;

/** Rates are carried as base units × this scale per second, so tiny rates keep their precision. */
export const REWARD_RATE_SCALE = 1_000_000n;

/** Whether a reward has been accruing for longer than the close itself takes. */
export function rewardIsWorthClaiming(reward: bigint, rewardRateScaled: bigint): boolean {
  if (reward <= 0n) return false;
  return reward * REWARD_RATE_SCALE > rewardRateScaled * REWARD_DUST_WINDOW_SECONDS;
}
