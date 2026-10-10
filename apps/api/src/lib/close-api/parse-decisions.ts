import type { DecisionAnswer } from "@lumenwipe/types";
import { fail } from "@/common/fail";

export const MAX_DECISIONS = 1000;
const MAX_ID_LENGTH = 200;
const MAX_CHOICE_LENGTH = 64;
const MAX_MIN_AMOUNT_OUT_LENGTH = 40;
const MAX_PROVIDER_LENGTH = 32;
// A muxed (M...) address is 69 characters; a G... address is 56.
const MAX_DESTINATION_LENGTH = 69;

type Params = NonNullable<DecisionAnswer["params"]>;

const boundedString =
  (max: number) =>
  (value: unknown): boolean =>
    typeof value === "string" && value.length <= max;

// Keyed by every field of the shared type, so adding a param there fails type-check until the
// guard knows how to validate it.
const PARAM_VALIDATORS: { [K in keyof Params]-?: (value: unknown) => boolean } = {
  maxSlippageBps: (value) => typeof value === "number" && Number.isFinite(value),
  minAmountOut: boundedString(MAX_MIN_AMOUNT_OUT_LENGTH),
  provider: boundedString(MAX_PROVIDER_LENGTH),
  destination: boundedString(MAX_DESTINATION_LENGTH),
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string): never => fail("invalid_decisions", message, 400);

/**
 * Validates the caller's decision answers and returns the very same array: nothing is copied,
 * defaulted or stripped, so a payload that passes reaches plan hashing and transaction
 * construction byte for byte as it was sent.
 */
export function parseDecisions(value: unknown): DecisionAnswer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("decisions must be an array of answers.");
  const answers = value as unknown[];
  if (answers.length > MAX_DECISIONS) {
    invalid(`At most ${MAX_DECISIONS} decision answers are allowed per request.`);
  }
  answers.forEach((answer, index) => {
    const at = `decisions[${index}]`;
    if (!isPlainObject(answer)) return invalid(`${at} must be an object.`);
    const { id, choice, params } = answer;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
      invalid(`${at}.id must be a non-empty string of at most ${MAX_ID_LENGTH} characters.`);
    }
    if (typeof choice !== "string" || choice.length === 0 || choice.length > MAX_CHOICE_LENGTH) {
      invalid(
        `${at}.choice must be a non-empty string of at most ${MAX_CHOICE_LENGTH} characters.`
      );
    }
    if (params === undefined) return;
    if (!isPlainObject(params)) return invalid(`${at}.params must be an object.`);
    for (const key of Object.keys(PARAM_VALIDATORS) as (keyof Params)[]) {
      if (params[key] !== undefined && !PARAM_VALIDATORS[key](params[key])) {
        invalid(`${at}.params.${key} is not valid.`);
      }
    }
  });
  return value as DecisionAnswer[];
}
