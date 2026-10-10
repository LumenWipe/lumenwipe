import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ErrorEnvelopeFilter } from "@/common/error-envelope.filter";
import {
  type DomainErrorEntry,
  mapDomainError,
  PLAN_ERRORS,
  TRANSACTION_ERRORS,
} from "@/lib/close-api/domain-errors";

function respond(entries: readonly DomainErrorEntry[], exception: unknown, host: ArgumentsHost) {
  const mapped = mapDomainError(entries, exception);
  if (!mapped) {
    new ErrorEnvelopeFilter().catch(exception, host);
    return;
  }
  const error: Record<string, unknown> = { code: mapped.code, message: mapped.message };
  if (mapped.details !== undefined) error.details = mapped.details;
  host.switchToHttp().getResponse<Response>().status(mapped.status).json({ error });
}

@Catch(...PLAN_ERRORS.map((e) => e.type))
export class PlanErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    respond(PLAN_ERRORS, exception, host);
  }
}

@Catch(...TRANSACTION_ERRORS.map((e) => e.type))
export class TransactionErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    respond(TRANSACTION_ERRORS, exception, host);
  }
}
