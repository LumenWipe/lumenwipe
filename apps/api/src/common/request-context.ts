import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { xdr } from "@stellar/stellar-sdk";
import type { AuthedRequest } from "@/auth/api-key.guard";
import { REQUEST_DEADLINE_MS } from "@/config/constants";
import { createDeadline, type Deadline } from "./deadline";

export const REQUEST_ID_HEADER = "x-request-id";

interface RequestContext {
  requestId: string;
  sensitive: Set<string>;
  deadline: Deadline;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function currentSensitiveLiterals(): Iterable<string> {
  return storage.getStore()?.sensitive ?? [];
}

/** Aborts once the request has used its whole upstream budget; absent outside a request. */
export function currentDeadline(): Deadline | undefined {
  return storage.getStore()?.deadline;
}

/** Marks a value the current request carried (a deposit memo) as never to be logged. */
export function markSensitive(value: unknown): void {
  if (typeof value === "string" && value.length > 0) storage.getStore()?.sensitive.add(value);
}

function withRequestId(body: unknown, requestId: string): unknown {
  if (typeof body !== "object" || body === null || !("error" in body)) return body;
  const { error } = body as { error: unknown };
  if (typeof error !== "object" || error === null || Array.isArray(error)) return body;
  return { ...body, error: { ...error, requestId } };
}

function severityMethod(status: number): "log" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "log";
}

/**
 * Gives every request an id before anything that can answer it, sets the headers every
 * response carries (`x-request-id`, `Cache-Control: no-store`), copies the id into any error
 * envelope, and writes one access line when the response finishes.
 *
 * The id is always generated here: a caller-supplied one would let a client forge or inject
 * into the log line it is meant to be matched against. The access line carries the matched route
 * pattern, never the raw path, because paths hold account addresses.
 */
export function requestContextMiddleware(deadlineMs: number = REQUEST_DEADLINE_MS): RequestHandler {
  const logger = new Logger("http");
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader("Cache-Control", "no-store");

    const json = res.json.bind(res);
    res.json = ((body?: unknown) =>
      json(res.statusCode >= 400 ? withRequestId(body, requestId) : body)) as Response["json"];

    res.on("finish", () => {
      if (req.path === "/health") return;
      const params = req.params as Record<string, string | undefined> | undefined;
      logger[severityMethod(res.statusCode)]({
        message: "request",
        route: req.route ? `${req.baseUrl}${String(req.route.path)}` : "unrouted",
        status: res.statusCode,
        latencyMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        keyLabel: (req as AuthedRequest).apiKeyLabel,
        network: params?.network,
      });
    });

    storage.run({ requestId, sensitive: new Set(), deadline: createDeadline(deadlineMs) }, next);
  };
}

function memoOfEnvelope(signedXdr: string): string | undefined {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(signedXdr, "base64");
    const tx =
      envelope.switch().name === "envelopeTypeTxFeeBump"
        ? envelope.feeBump().tx().innerTx().v1().tx()
        : envelope.v1().tx();
    const memo = tx.memo();
    if (memo.switch().name === "memoText") return memo.text().toString("utf8");
    if (memo.switch().name === "memoId") return memo.id().toString();
  } catch {
    return undefined;
  }
  return undefined;
}

/** After body parsing: the memo is the one body value that identifies a deposit, so it is
 *  registered for removal from every line the rest of the request writes, whether it arrived as a
 *  field or inside a signed envelope. */
export const registerRequestSecrets: RequestHandler = (req, _res, next) => {
  const body: unknown = req.body;
  if (typeof body === "object" && body !== null) {
    const { memo, signedXdr } = body as { memo?: unknown; signedXdr?: unknown };
    markSensitive(memo);
    if (typeof signedXdr === "string") markSensitive(memoOfEnvelope(signedXdr));
  }
  next();
};
