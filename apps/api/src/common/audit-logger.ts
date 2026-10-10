import { Injectable, Logger } from "@nestjs/common";

export type AuditEvent = "api_key.create" | "api_key.rotate" | "api_key.revoke";

const HASH = /^[0-9a-f]{64}$/;
const KEY_ID_LENGTH = 8;

/** A key hash arrives from a URL on revoke and rotate, so only a well-formed one is cut to its
 *  id; anything else is logged as null rather than echoing what the caller sent. */
export function keyIdOf(hash: string | null | undefined): string | null {
  return hash && HASH.test(hash) ? hash.slice(0, KEY_ID_LENGTH) : null;
}

/** What an action learns while it runs; whatever is unset when it ends is logged as null. */
export interface AuditScope {
  owner?: string;
  keyHash?: string;
  newKeyHash?: string;
}

/**
 * Writes exactly one line per key lifecycle action, whether it succeeds or throws. A failure
 * carries no error text: the exception is rethrown untouched for the error filter, which owns
 * logging the failure itself.
 */
@Injectable()
export class AuditLogger {
  private readonly logger = new Logger("audit");

  async track<T>(
    event: AuditEvent,
    actor: string,
    action: (scope: AuditScope) => Promise<T>
  ): Promise<T> {
    const scope: AuditScope = {};
    try {
      const result = await action(scope);
      this.write("log", event, actor, scope, "success");
      return result;
    } catch (error) {
      this.write("warn", event, actor, scope, "failure");
      throw error;
    }
  }

  private write(
    level: "log" | "warn",
    event: AuditEvent,
    actor: string,
    scope: AuditScope,
    result: "success" | "failure"
  ): void {
    this.logger[level]({
      message: "api key lifecycle",
      event,
      actor,
      keyId: keyIdOf(scope.keyHash),
      ...(scope.newKeyHash !== undefined && { newKeyId: keyIdOf(scope.newKeyHash) }),
      owner: scope.owner ?? null,
      result,
    });
  }
}
