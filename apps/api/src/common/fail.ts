import { HttpException } from "@nestjs/common";

/**
 * The API's single error envelope: `{ error: { code, message, details? } }`.
 *
 * It used to be two. Auth returned this shape while account, paths and mediator returned a flat
 * `{ error: "some string" }`, so a client could not read an error without knowing which
 * endpoint produced it - `apps/web/lib/api/close-client.ts` still carries the ternary that
 * inconsistency forced, checking whether `error` is an object or a string before it can find
 * the message.
 *
 * `code` is the part a caller can branch on. A message is for a human and will be reworded; a
 * code is a contract, which is why every call site names one rather than letting the status
 * carry the meaning.
 */
export function fail(code: string, message: string, status: number, details?: unknown): never {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  throw new HttpException({ error }, status);
}
