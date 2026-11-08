import { fail } from "@/common/fail";
import { isValidNetwork, VALID_NETWORKS, type Network } from "@/config/networks";

export const MAX_LABEL_LENGTH = 64;

export function parseLabel(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "string") {
    const label = input.trim();
    const length = [...label].length;
    if (length >= 1 && length <= MAX_LABEL_LENGTH && !/[\p{Cc}\p{Cf}]/u.test(label)) return label;
  }
  fail(
    "invalid_label",
    `label must be a string of 1 to ${MAX_LABEL_LENGTH} printable characters, or omitted.`,
    400
  );
}

export function parseNetworks(input: unknown): Network[] | null {
  if (input === undefined || input === null) return null;
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((n) => typeof n === "string" && isValidNetwork(n))
  ) {
    return VALID_NETWORKS.filter((n) => input.includes(n));
  }
  fail(
    "invalid_networks",
    `networks must be a non-empty list of ${VALID_NETWORKS.join(" and ")}, or omitted.`,
    400
  );
}
