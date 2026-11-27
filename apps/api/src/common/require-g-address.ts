import type { ErrorCode } from "@lumenwipe/types";
import { fail } from "@/common/fail";
import {
  isValidGAddress,
  UNSUPPORTED_ADDRESS_MESSAGES,
  unsupportedAddressKind,
  type UnsupportedAddressKind,
} from "@/lib/utils/validation";

/** The 400 for a valid contract or muxed contract address, naming its kind. */
export function failUnsupportedAddress(kind: UnsupportedAddressKind): never {
  fail("unsupported_address_type", UNSUPPORTED_ADDRESS_MESSAGES[kind], 400, {
    addressType: kind,
  });
}

/**
 * Refuses anything that is not an ed25519 account address. A valid C... or W... strkey gets
 * `unsupported_address_type`; everything else keeps the caller's own code and message.
 */
export function requireGAddress(
  value: unknown,
  code: ErrorCode,
  message: string
): asserts value is string {
  if (typeof value === "string" && isValidGAddress(value)) return;
  const kind = unsupportedAddressKind(value);
  if (kind !== null) failUnsupportedAddress(kind);
  fail(code, message, 400);
}
