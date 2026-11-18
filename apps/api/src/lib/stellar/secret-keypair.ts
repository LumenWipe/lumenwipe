import { Keypair } from "@stellar/stellar-sdk";
import type { Logger } from "@nestjs/common";

/**
 * Reads a signing seed from the environment variable `variable`, trimmed, so the trailing newline a
 * secret written from a file keeps does not decide whether signing works. Returns null when the
 * variable is unset or empty, or when its value is not a valid secret seed; the latter is logged
 * by variable name only, never with the value or the SDK's error, which could echo it.
 */
export function keypairFromEnv(variable: string, logger: Logger): Keypair | null {
  const secret = process.env[variable]?.trim();
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    logger.error({
      message: "configured signing seed is not a valid Stellar secret seed",
      variable,
    });
    return null;
  }
}
